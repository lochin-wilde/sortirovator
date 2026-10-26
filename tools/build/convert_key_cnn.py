#!/usr/bin/env python3
"""Convert madmom's key CNN to a flat file the browser can read.

The network is Korzeniowski & Widmer, "Genre-Agnostic Key Classification with
Convolutional Neural Networks" (ISMIR 2018), as shipped in madmom_models:
key/2018/key_cnn.pkl. madmom stores it as a pickle of its own layer classes;
the browser needs plain numbers. This writes

    "KCN1"                  4 bytes, magic
    header length           uint32, little-endian
    header                  JSON: the layers in order, each with the offsets
                            (in float32s) of its parameters in the data block
    padding                 to a multiple of 4 bytes
    data                    float32, little-endian

The model files are licensed CC BY-NC-SA 4.0 by their authors, and so is this
converted form of them -- see web/data/KEY_CNN_LICENSE.txt.

Loading
-------
A pickle can run code as it loads. This one comes from the authors' own
repository, but it is still read with an unpickler that refuses everything
except numpy array reconstruction; madmom's classes are rebuilt as plain
records, never imported. madmom does not need to be installed.

Usage
-----
    python3 tools/build/convert_key_cnn.py path/to/madmom_models/key/2018/key_cnn.pkl web/data/key_cnn.bin
"""
import json
import pickle
import struct
import sys

import numpy as np


class Record:
    def __init__(self, *args, **kwargs):
        pass

    def __setstate__(self, state):
        self.__dict__.update(state)


ALLOWED = {
    ("numpy.core.multiarray", "_reconstruct"),
    ("numpy._core.multiarray", "_reconstruct"),
    ("numpy", "ndarray"),
    ("numpy", "dtype"),
}


class SafeUnpickler(pickle.Unpickler):
    def find_class(self, module, name):
        if (module, name) in ALLOWED:
            return getattr(__import__(module, fromlist=[name]), name)
        if module.startswith("madmom"):
            # Activation functions are referenced by name; keep only the name.
            if name[0].islower():
                return type("Fn", (), {"fn": name})
            return type(name, (Record,), {"cls": name})
        raise pickle.UnpicklingError(f"refused to load {module}.{name}")


def activation(layer):
    fn = getattr(layer, "activation_fn", None)
    return getattr(fn, "fn", None) if fn is not None else None


def main(src, dst):
    with open(src, "rb") as f:
        model = SafeUnpickler(f, encoding="latin1").load()

    data = []
    offset = 0

    def put(array):
        nonlocal offset
        flat = np.asarray(array, dtype=np.float32).ravel(order="C")
        data.append(flat)
        start = offset
        offset += flat.size
        return start

    layers = []
    for layer in model.layers:
        kind = layer.cls
        if kind == "PadLayer":
            if tuple(layer.axes) != (0, 1) or float(layer.value) != 0.0:
                raise ValueError("only zero padding of time and frequency is supported")
            layers.append({"type": "pad", "width": int(layer.width)})
        elif kind == "ConvolutionalLayer":
            if layer.pad != "valid" or layer.stride not in (None, 1, (1, 1)):
                raise ValueError("only stride-1 valid convolutions are supported")
            if activation(layer) not in (None, "linear"):
                raise ValueError("unexpected activation on a convolution: %r" % activation(layer))
            w = np.asarray(layer.weights, dtype=np.float32)
            bias = np.asarray(layer.bias)
            if np.any(bias != 0):
                raise ValueError("convolution bias is not zero; add support before converting")
            c_in, c_out, kh, kw = w.shape
            layers.append({"type": "conv", "in": c_in, "out": c_out, "kh": kh, "kw": kw,
                           "weights": put(w)})
        elif kind == "BatchNormLayer":
            if activation(layer) != "elu":
                raise ValueError("expected ELU after batch norm, got %r" % activation(layer))
            n = int(np.asarray(layer.beta).size)
            # Folded: out = elu(x * scale + shift), scale = gamma * inv_std,
            # shift = beta - mean * scale -- the same arithmetic as madmom's
            # (x - mean) * (gamma * inv_std) + beta, rearranged.
            scale = np.asarray(layer.gamma, np.float64) * np.asarray(layer.inv_std, np.float64)
            shift = np.asarray(layer.beta, np.float64) - np.asarray(layer.mean, np.float64) * scale
            layers.append({"type": "bn_elu", "n": n, "scale": put(scale), "shift": put(shift)})
        elif kind == "MaxPoolLayer":
            if tuple(layer.size) != (2, 2) or tuple(layer.stride) != (2, 2):
                raise ValueError("only 2x2 max pooling is supported")
            layers.append({"type": "maxpool2"})
        elif kind == "AverageLayer":
            if tuple(layer.axis) != (0, 1):
                raise ValueError("only averaging over time and frequency is supported")
            layers.append({"type": "mean"})
        else:
            raise ValueError("unsupported layer " + kind)

    header = json.dumps({
        "model": "madmom key/2018/key_cnn.pkl (Korzeniowski & Widmer, ISMIR 2018)",
        "license": "CC BY-NC-SA 4.0",
        "classes": "A major .. Ab major, then A minor .. G# minor (madmom KEY_LABELS)",
        "floats": offset,
        "layers": layers,
    }, separators=(",", ":")).encode("utf-8")
    pad = (-(8 + len(header))) % 4
    with open(dst, "wb") as f:
        f.write(b"KCN1")
        f.write(struct.pack("<I", len(header) + pad))
        f.write(header + b" " * pad)
        f.write(np.concatenate(data).astype("<f4").tobytes())
    print("%d layers, %d parameters -> %s" % (len(layers), offset, dst))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
