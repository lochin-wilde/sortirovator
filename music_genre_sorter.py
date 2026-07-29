#!/usr/bin/env python3
"""
Music Genre Sorter - Cross-platform web interface for sorting music by genre.
Automatically sorts music files by genre using metadata, online APIs, and local ML analysis.

Dependencies:
pip install requests mutagen librosa numpy tqdm musicbrainzngs flask

Usage:
python music_genre_sorter.py --input /path/to/music --dry-run
python music_genre_sorter.py --web  # Start web interface
"""

import argparse
import difflib
import json
import logging
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Optional, Tuple

# Flask imports — must come before any route/app definitions
from flask import Flask, request, render_template_string, redirect, url_for, jsonify
from mutagen import File as MutagenFile
from mutagen.mp3 import MP3
from mutagen.easyid3 import EasyID3
from mutagen.id3 import ID3NoHeaderError
from mutagen.flac import FLAC
from mutagen.mp4 import MP4

import imageio_ffmpeg
from unidecode import unidecode
from transliterate import translit
import librosa
import musicbrainzngs
import numpy as np
import pyloudnorm
import requests
import scipy.signal
import soundfile as sf
import tqdm

FFMPEG_EXE = imageio_ffmpeg.get_ffmpeg_exe()

try:
    from waitress import serve
    HAS_WAITRESS = True
except ImportError:
    HAS_WAITRESS = False

try:
    import acoustid
    HAS_ACOUSTID = True
except ImportError:
    HAS_ACOUSTID = False

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Constants — use cross-platform home directory instead of hardcoded macOS path
DEFAULT_INPUT_DIR = str(Path.home() / "Music")
SORTED_DIR = os.path.join(DEFAULT_INPUT_DIR, "SortedMusic")
GENRES_MAP_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "genres_map.json")
SUPPORTED_EXTENSIONS = {'.mp3', '.wav', '.flac', '.m4a'}

# Flask application
app = Flask(__name__)

# In-memory registry of background unified-processing jobs, keyed by job_id
_PROCESS_JOBS: dict = {}
_PROCESS_JOBS_LOCK = threading.Lock()

# Default genres mapping (expanded based on MusicBrainz genres)
DEFAULT_GENRES_MAP = {
    # Hip-Hop
    'afro trap': 'Hip-Hop', 'afrobeat': 'Hip-Hop', 'alternative hip-hop': 'Hip-Hop', 'boom bap': 'Hip-Hop',
    'brazilian phonk': 'Hip-Hop', 'brooklyn drill': 'Hip-Hop', 'chicano rap': 'Hip-Hop',
    'christian hip-hop': 'Hip-Hop', 'cloud rap': 'Hip-Hop', 'conscious hip hop': 'Hip-Hop',
    'conscious hip-hop': 'Hip-Hop', 'crunk': 'Hip-Hop', 'dancehall': 'Hip-Hop', 'drift phonk': 'Hip-Hop',
    'drill': 'Hip-Hop', 'east coast hip hop': 'Hip-Hop', 'east coast hip-hop': 'Hip-Hop',
    'emo rap': 'Hip-Hop', 'grime': 'Hip-Hop', 'hardcore hip-hop': 'Hip-Hop', 'hip-hop': 'Hip-Hop',
    'instrumental hip-hop': 'Hip-Hop', 'jerk': 'Hip-Hop', 'jewish hip-hop': 'Hip-Hop',
    'latin hip-hop': 'Hip-Hop', 'latin trap': 'Hip-Hop', 'lo-fi hip-hop': 'Hip-Hop', 'miami bass': 'Hip-Hop',
    'mumble rap': 'Hip-Hop', 'nerdcore': 'Hip-Hop', 'phonk': 'Hip-Hop', 'plugg': 'Hip-Hop',
    'pluggnb': 'Hip-Hop', 'political hip-hop': 'Hip-Hop', 'rage': 'Hip-Hop', 'rap': 'Hip-Hop',
    'reggaeton': 'Hip-Hop', 'southern hip hop': 'Hip-Hop', 'southern hip-hop': 'Hip-Hop', 'trap': 'Hip-Hop',
    'tread rap': 'Hip-Hop', 'trip-hop': 'Hip-Hop', 'uk drill': 'Hip-Hop', 'uk trap': 'Hip-Hop',
    'underground hip-hop': 'Hip-Hop', 'west coast hip hop': 'Hip-Hop', 'west coast hip-hop': 'Hip-Hop',

    # House
    'acid house': 'House', 'afro house': 'House', 'afro tech': 'House', 'amapiano': 'House',
    'ambient house': 'House', 'balearic beat': 'House', 'bass house': 'House', 'big room house': 'House',
    'blog house': 'House', 'brazilian bass': 'House', 'chicago hard house': 'House',
    'chicago house': 'House', 'complextro': 'House', 'deep house': 'House', 'disco house': 'House',
    'diva house': 'House', 'dutch house': 'House', 'electro hop': 'House', 'electro house': 'House',
    'electro swing': 'House', 'eurohouse': 'House', 'fidget house': 'House', 'french house': 'House',
    'funky house': 'House', 'future house': 'House', 'future rave': 'House', 'garage house': 'House',
    'ghetto house': 'House', 'ghettotech': 'House', 'gqom': 'House', 'hardbag': 'House', 'hardbass': 'House',
    'hip house': 'House', 'house': 'House', 'italo house': 'House', 'jackin house': 'House',
    'jazz house': 'House', 'juke house': 'House', 'kidandali': 'House', 'kwaito': 'House',
    'latin house': 'House', 'lo-fi house': 'House', 'melbourne bounce': 'House', 'melodic house': 'House',
    'microhouse': 'House', 'moombahcore': 'House', 'moombahsoul': 'House', 'moombahton': 'House',
    'new jersey sound': 'House', 'outsider house': 'House', 'progressive house': 'House',
    'pumping house': 'House', 'scouse house': 'House', 'slap house': 'House', 'soulful house': 'House',
    'stadium house': 'House', 'tech house': 'House', 'tribal house': 'House', 'tropical house': 'House',
    'trouse': 'House', 'uk hard house': 'House',

    # Techno
    'acid': 'Techno', 'acid techno': 'Techno', 'ambient techno': 'Techno', 'birmingham sound': 'Techno',
    'bleep techno': 'Techno', 'bouncy techno': 'Techno', 'detroit techno': 'Techno', 'dub techno': 'Techno',
    'free tekno': 'Techno', 'hard techno': 'Techno', 'industrial techno': 'Techno', 'jungletek': 'Techno',
    'minimal': 'Techno', 'minimal techno': 'Techno', 'raggatek': 'Techno', 'schaffel': 'Techno',
    'techno': 'Techno', 'toytown techno': 'Techno',

    # Trance
    'acid trance': 'Trance', 'balearic trance': 'Trance', 'dark psytrance': 'Trance',
    'dream trance': 'Trance', 'eurotrance': 'Trance', 'full-on': 'Trance', 'goa trance': 'Trance',
    'hands up': 'Trance', 'hard trance': 'Trance', 'minimal psytrance': 'Trance', 'nitzhonot': 'Trance',
    'progressive psytrance': 'Trance', 'progressive trance': 'Trance', 'psychedelic trance': 'Trance',
    'suomisaundi': 'Trance', 'tech trance': 'Trance', 'trance': 'Trance', 'uplifting trance': 'Trance',
    'vocal trance': 'Trance',

    # Drum & Bass
    'atmospheric drum and bass': 'Drum & Bass', 'darkstep': 'Drum & Bass', "drill 'n' bass": 'Drum & Bass',
    'drum & bass': 'Drum & Bass', 'drum and bass': 'Drum & Bass', 'drumfunk': 'Drum & Bass',
    'drumstep': 'Drum & Bass', 'hardstep': 'Drum & Bass', 'intelligent drum and bass': 'Drum & Bass',
    'jazzstep': 'Drum & Bass', 'jungle': 'Drum & Bass', 'liquid funk': 'Drum & Bass',
    'neurofunk': 'Drum & Bass', 'ragga jungle': 'Drum & Bass', 'sambass': 'Drum & Bass',
    'techstep': 'Drum & Bass',

    # Dubstep
    '2-step garage': 'Dubstep', 'bass music': 'Dubstep', 'bassline': 'Dubstep', 'breakstep': 'Dubstep',
    'dubstep': 'Dubstep', 'funkstep': 'Dubstep', 'future bass': 'Dubstep', 'future garage': 'Dubstep',
    'glitch hop': 'Dubstep', 'grindie': 'Dubstep', 'kawaii future bass': 'Dubstep',
    'midtempo bass': 'Dubstep', 'speed garage': 'Dubstep', 'trap (edm)': 'Dubstep', 'uk bass': 'Dubstep',
    'uk funky': 'Dubstep', 'wonky': 'Dubstep',

    # Hardstyle
    'breakbeat hardcore': 'Hardstyle', 'breakcore': 'Hardstyle', 'darkcore': 'Hardstyle',
    'digital hardcore': 'Hardstyle', 'dubstyle': 'Hardstyle', 'early hardcore': 'Hardstyle',
    'euphoric frenchcore': 'Hardstyle', 'euphoric hardstyle': 'Hardstyle', 'extratone': 'Hardstyle',
    'flashcore': 'Hardstyle', 'frenchcore': 'Hardstyle', 'gabber': 'Hardstyle',
    'happy hardcore': 'Hardstyle', 'hard dance': 'Hardstyle', 'hard nrg': 'Hardstyle',
    'hardcore': 'Hardstyle', 'hardcore breaks': 'Hardstyle', 'hardstyle': 'Hardstyle',
    'industrial hardcore': 'Hardstyle', 'j-core': 'Hardstyle', 'jumpstyle': 'Hardstyle',
    'lento violento': 'Hardstyle', 'mainstream hardcore': 'Hardstyle', 'mákina': 'Hardstyle',
    'raggacore': 'Hardstyle', 'rawstyle': 'Hardstyle', 'speedcore': 'Hardstyle', 'splittercore': 'Hardstyle',
    'trapstyle': 'Hardstyle', 'uk hardcore': 'Hardstyle',

    # Electronic
    'acid breaks': 'Electronic', 'acousmatic music': 'Electronic', 'afro/cosmic music': 'Electronic',
    'afrobeats': 'Electronic', 'afroswing': 'Electronic', 'aggrotech': 'Electronic',
    'algorave': 'Electronic', 'ambient': 'Electronic', 'ambient dub': 'Electronic',
    'asian underground': 'Electronic', 'avant-garde': 'Electronic', 'azonto': 'Electronic',
    'baltimore club': 'Electronic', 'berlin school': 'Electronic', 'big beat': 'Electronic',
    'bitpop': 'Electronic', 'black midi': 'Electronic', 'breakbeat': 'Electronic',
    'broken beat': 'Electronic', 'budots': 'Electronic', 'changa tuki': 'Electronic',
    'chill-out': 'Electronic', 'chillwave': 'Electronic', 'chiptune': 'Electronic',
    'coupé-décalé': 'Electronic', 'cyber metal': 'Electronic', 'dance': 'Electronic',
    'dancehall pop': 'Electronic', 'danger music': 'Electronic', 'dark ambient': 'Electronic',
    'dark electro': 'Electronic', 'darksynth': 'Electronic', 'death industrial': 'Electronic',
    'deconstructed club': 'Electronic', 'denpa music': 'Electronic', 'downtempo': 'Electronic',
    'dreampunk': 'Electronic', 'drone': 'Electronic', 'dub': 'Electronic', 'dub poetry': 'Electronic',
    'electro': 'Electronic', 'electro-disco': 'Electronic', 'electro-industrial': 'Electronic',
    'electroacoustic music': 'Electronic', 'electronic': 'Electronic',
    'electronic body music (ebm)': 'Electronic', 'electronic pop': 'Electronic', 'electronica': 'Electronic',
    'eurodance': 'Electronic', 'experimental': 'Electronic', 'experimental electronic': 'Electronic',
    'florida breaks': 'Electronic', 'fm synthesis': 'Electronic', 'folktronica': 'Electronic',
    'funk carioca': 'Electronic', 'funk melody': 'Electronic', 'funk ostentação': 'Electronic',
    'funktronica': 'Electronic', 'future funk': 'Electronic', 'futurepop': 'Electronic',
    'glitch': 'Electronic', 'guaracha (edm)': 'Electronic', 'hardvapour': 'Electronic',
    'hardwave': 'Electronic', 'harsh noise': 'Electronic', 'harsh noise wall': 'Electronic',
    'hauntology': 'Electronic', 'hi-nrg': 'Electronic', 'hypnagogic pop': 'Electronic', 'idm': 'Electronic',
    'illbient': 'Electronic', 'indietronica': 'Electronic', 'industrial': 'Electronic',
    'industrial hip-hop': 'Electronic', 'intelligent dance music (idm)': 'Electronic',
    'japanoise': 'Electronic', 'jersey club': 'Electronic', 'jungle terror': 'Electronic',
    'kosmische musik': 'Electronic', 'kuduro': 'Electronic', 'laptronica': 'Electronic',
    'lowercase': 'Electronic', 'mahraganat': 'Electronic', 'mallsoft': 'Electronic',
    'manila sound': 'Electronic', 'martial industrial': 'Electronic', 'merenhouse': 'Electronic',
    'microsound': 'Electronic', 'minimal wave': 'Electronic', 'musique concrète': 'Electronic',
    'neoclassical dark wave': 'Electronic', 'neue deutsche todeskunst': 'Electronic',
    'neue deutsche welle': 'Electronic', 'new beat': 'Electronic', 'new rave': 'Electronic',
    'new-age': 'Electronic', 'noise': 'Electronic', 'noise music': 'Electronic', 'nortec': 'Electronic',
    'nu skool breaks': 'Electronic', 'nu-disco': 'Electronic', 'nu-gaze': 'Electronic',
    'onkyokei': 'Electronic', 'philly club': 'Electronic', 'plunderphonics': 'Electronic',
    'pop kreatif': 'Electronic', 'post-disco': 'Electronic', 'post-industrial': 'Electronic',
    'power electronics': 'Electronic', 'power noise': 'Electronic', 'progressive breaks': 'Electronic',
    'progressive electronic': 'Electronic', 'proibidão': 'Electronic', 'psybient': 'Electronic',
    'psychedelic breakbeat': 'Electronic', 'psydub': 'Electronic', 'rabòday': 'Electronic',
    'rara tech': 'Electronic', 'rasteirinha': 'Electronic', 'reductionism': 'Electronic',
    'reggae': 'Electronic', 'rocksteady': 'Electronic', 'russ music': 'Electronic',
    'sampledelia': 'Electronic', 'sequencer music': 'Electronic', 'shamstep': 'Electronic',
    'shangaan electro': 'Electronic', 'ska': 'Electronic', 'skweee': 'Electronic',
    'soundscape': 'Electronic', 'sovietwave': 'Electronic', 'space disco': 'Electronic',
    'space music': 'Electronic', 'spacesynth': 'Electronic', 'synth-metal': 'Electronic',
    'synth-pop': 'Electronic', 'synth-punk': 'Electronic', 'synthwave': 'Electronic',
    'tecnocumbia': 'Electronic', 'tribal guarachero': 'Electronic', 'trip hop': 'Electronic',
    'trip rock': 'Electronic', 'vaporwave': 'Electronic', 'wave': 'Electronic', 'witch house': 'Electronic',

    # Rock
    'acid rock': 'Rock', 'active rock': 'Rock', 'adult album alternative': 'Rock', 'afro punk': 'Rock',
    'afro rock': 'Rock', 'album oriented rock': 'Rock', 'alternative': 'Rock', 'alternative dance': 'Rock',
    'alternative metal': 'Rock', 'alternative rock': 'Rock', 'american rock': 'Rock', 'anarcho punk': 'Rock',
    'anatolian rock': 'Rock', 'arabic rock': 'Rock', 'arena rock': 'Rock', 'art punk': 'Rock',
    'art rock': 'Rock', 'atmospheric black metal': 'Rock', 'avant-garde black metal': 'Rock',
    'avant-garde metal': 'Rock', 'avant-prog': 'Rock', 'baggy': 'Rock', 'bardcore': 'Rock', 'beat': 'Rock',
    'beatdown hardcore': 'Rock', 'black metal': 'Rock', 'blackened death metal': 'Rock',
    'blackened deathcore': 'Rock', 'blackened doom': 'Rock', 'blackgaze': 'Rock', 'blog rock': 'Rock',
    'boogie rock': 'Rock', 'brazilian rock': 'Rock', 'british folk rock': 'Rock', 'british invasion': 'Rock',
    'british rock music': 'Rock', 'brutal death metal': 'Rock', 'bubblegrunge': 'Rock',
    'canterbury scene': 'Rock', 'celtic metal': 'Rock', 'celtic punk': 'Rock', 'celtic rock': 'Rock',
    'chicano rock': 'Rock', 'chinese rock': 'Rock', 'christian hardcore': 'Rock', 'christian metal': 'Rock',
    'christian punk': 'Rock', 'christian rock': 'Rock', 'classic alternative': 'Rock',
    'classic rock': 'Rock', 'cleveland punk': 'Rock', 'cold wave': 'Rock', 'college rock': 'Rock',
    'comedy rock': 'Rock', 'country rock': 'Rock', 'cowpunk': 'Rock', 'crabcore': 'Rock',
    'crossover thrash': 'Rock', 'crunkcore': 'Rock', 'crust punk': 'Rock', 'crustgrind': 'Rock',
    'cyberpunk': 'Rock', 'd synth punk': 'Rock', 'd-beat': 'Rock', 'dance-punk': 'Rock',
    'dance-rock': 'Rock', 'dark cabaret': 'Rock', 'dark wave': 'Rock', "death 'n' roll": 'Rock',
    'death metal': 'Rock', 'death-doom': 'Rock', 'deathcore': 'Rock', 'deathgrind': 'Rock',
    'deathrock': 'Rock', 'depressive suicidal black metal': 'Rock', 'desert rock': 'Rock', 'djent': 'Rock',
    'doom metal': 'Rock', 'dream pop': 'Rock', 'drone doom': 'Rock', 'drone metal': 'Rock',
    'dunedin sound': 'Rock', 'easycore': 'Rock', 'egg punk': 'Rock', 'electroclash': 'Rock',
    'electrogrind': 'Rock', 'electronic rock': 'Rock', 'electronicore': 'Rock', 'electropunk': 'Rock',
    'emo': 'Rock', 'ethereal wave': 'Rock', 'experimental rock': 'Rock', 'extreme metal': 'Rock',
    'flamenco rock': 'Rock', 'folk metal': 'Rock', 'folk punk': 'Rock', 'folk rock': 'Rock',
    'freak scene': 'Rock', 'freakbeat': 'Rock', 'funeral doom': 'Rock', 'funk metal': 'Rock',
    'funk rock': 'Rock', 'garage punk': 'Rock', 'garage rock': 'Rock', 'geek rock': 'Rock',
    'german punk': 'Rock', 'glam metal': 'Rock', 'glam punk': 'Rock', 'glam rock': 'Rock',
    'goregrind': 'Rock', 'gothabilly': 'Rock', 'gothic doom': 'Rock', 'gothic metal': 'Rock',
    'gothic punk': 'Rock', 'gothic rock': 'Rock', 'grindcore': 'Rock', 'groove metal': 'Rock',
    'grunge': 'Rock', 'gypsy punk': 'Rock', 'hard rock': 'Rock', 'hardcore punk': 'Rock',
    'heartland rock': 'Rock', 'heavy metal': 'Rock', 'horror punk': 'Rock', 'indian rock': 'Rock',
    'indie': 'Rock', 'indie rock': 'Rock', 'industrial metal': 'Rock', 'industrial rock': 'Rock',
    'instrumental rock': 'Rock', 'iranian rock': 'Rock', 'italian beat': 'Rock', 'japanese rock': 'Rock',
    'kawaii metal': 'Rock', 'kindie rock': 'Rock', 'krautrock': 'Rock', 'krishnacore': 'Rock',
    'landfill indie': 'Rock', 'latin alternative': 'Rock', 'latin metal': 'Rock', 'latin rock': 'Rock',
    'latino punk': 'Rock', 'madchester': 'Rock', 'mainstream rock': 'Rock', 'mangue bit': 'Rock',
    'math rock': 'Rock', 'mathcore': 'Rock', 'medieval folk rock': 'Rock', 'medieval metal': 'Rock',
    'melodic black metal': 'Rock', 'melodic death metal': 'Rock', 'melodic hardcore': 'Rock',
    'melodic metalcore': 'Rock', 'metal': 'Rock', 'metalcore': 'Rock', 'midwest emo': 'Rock', 'mod': 'Rock',
    'mod revival': 'Rock', 'modern rock': 'Rock', 'nagoya kei': 'Rock',
    'national socialist black metal': 'Rock', 'nazi punk': 'Rock', 'nederbeat': 'Rock', 'neo-prog': 'Rock',
    'neo-psychedelia': 'Rock', 'neoclassical metal': 'Rock', 'neue deutsche härte': 'Rock',
    'new prog': 'Rock', 'new wave': 'Rock', 'new wave of american heavy metal': 'Rock',
    'new wave of british heavy metal': 'Rock', 'new wave of classic rock': 'Rock',
    'new wave of new wave': 'Rock', 'new wave of traditional heavy metal': 'Rock', 'nintendocore': 'Rock',
    'no wave': 'Rock', 'noise pop': 'Rock', 'noise rock': 'Rock', 'noisecore': 'Rock', 'noisegrind': 'Rock',
    'nu metal': 'Rock', 'occult rock': 'Rock', 'oi!': 'Rock', 'pagan metal': 'Rock', 'pagan rock': 'Rock',
    'paisley underground': 'Rock', 'pirate metal': 'Rock', 'pop metal': 'Rock', 'pop punk': 'Rock',
    'pornogrind': 'Rock', 'positive hardcore': 'Rock', 'post-black metal': 'Rock', 'post-grunge': 'Rock',
    'post-hardcore': 'Rock', 'post-metal': 'Rock', 'post-progressive': 'Rock', 'post-punk': 'Rock',
    'post-punk revival': 'Rock', 'post-rock': 'Rock', 'power metal': 'Rock', 'powerviolence': 'Rock',
    'progressive metal': 'Rock', 'progressive metalcore': 'Rock', 'progressive rock': 'Rock',
    'proto-metal': 'Rock', 'proto-prog': 'Rock', 'proto-punk': 'Rock', 'psychedelic rock': 'Rock',
    'psychobilly': 'Rock', 'pub rock (australia)': 'Rock', 'pub rock (united kingdom)': 'Rock',
    'punk': 'Rock', 'punk funk': 'Rock', 'punk pathetique': 'Rock', 'punk rap': 'Rock', 'punk rock': 'Rock',
    'queercore': 'Rock', 'raga rock': 'Rock', 'rap metal': 'Rock', 'rap rock': 'Rock', 'rapcore': 'Rock',
    'red and anarchist black metal': 'Rock', 'reggae fusion': 'Rock', 'reggae punk': 'Rock',
    'reggae rock': 'Rock', 'riot grrrl': 'Rock', 'rock': 'Rock', 'rock and roll': 'Rock',
    'rock en español': 'Rock', 'rock in opposition': 'Rock', 'rock music in france': 'Rock',
    'rock music in mexico': 'Rock', 'rock opera': 'Rock', 'rockabilly': 'Rock', 'roots rock': 'Rock',
    'sadcore': 'Rock', 'samba rock': 'Rock', 'scottish gaelic punk': 'Rock', 'screamo': 'Rock',
    'second british invasion': 'Rock', 'shitgaze': 'Rock', 'shoegaze': 'Rock', 'ska punk': 'Rock',
    'skate punk': 'Rock', 'slacker rock': 'Rock', 'slam death metal': 'Rock', 'slowcore': 'Rock',
    'sludge doom': 'Rock', 'sludge metal': 'Rock', 'soft grunge': 'Rock', 'southern rock': 'Rock',
    'space rock': 'Rock', 'speed metal': 'Rock', 'stoner rock': 'Rock', 'stoner-doom': 'Rock',
    'street punk': 'Rock', 'sufi rock': 'Rock', 'surf punk': 'Rock', 'surf rock': 'Rock',
    'swamp rock': 'Rock', 'symphonic black metal': 'Rock', 'symphonic metal': 'Rock',
    'symphonic rock': 'Rock', 'taqwacore': 'Rock', 'technical death metal': 'Rock', 'thrash metal': 'Rock',
    'thrashcore': 'Rock', 'trallpunk': 'Rock', 'tropical rock': 'Rock', 'unblack metal': 'Rock',
    'viking metal': 'Rock', 'viking rock': 'Rock', 'visual kei': 'Rock', 'wizard rock': 'Rock',
    'world fusion': 'Rock', 'worldbeat': 'Rock', 'yacht rock': 'Rock', 'zeuhl': 'Rock',

    # Pop
    'adult contemporary': 'Pop', 'adult hits': 'Pop', 'alternative pop': 'Pop', 'ambient pop': 'Pop',
    'americana': 'Pop', 'anime song': 'Pop', 'arabic pop music': 'Pop', 'art pop': 'Pop', 'austropop': 'Pop',
    'avant-pop': 'Pop', 'bachata': 'Pop', 'baroque pop': 'Pop', 'beach music': 'Pop', 'bedroom pop': 'Pop',
    'bluegrass': 'Pop', 'brill building': 'Pop', 'britpop': 'Pop', 'bubblegum pop': 'Pop', 'c-pop': 'Pop',
    'canción': 'Pop', 'cantopop': 'Pop', 'canzone': 'Pop', 'chalga': 'Pop', 'chamber pop': 'Pop',
    'chanson': 'Pop', 'christian pop': 'Pop', 'city pop': 'Pop', 'classic hits': 'Pop',
    'classical crossover': 'Pop', 'contemporary hit radio': 'Pop', 'country': 'Pop', 'country pop': 'Pop',
    'cringe pop': 'Pop', 'dance-pop': 'Pop', 'dark pop': 'Pop', 'electropop': 'Pop', 'emo pop': 'Pop',
    'eurobeat': 'Pop', 'eurodisco': 'Pop', 'europop': 'Pop', 'folk': 'Pop', 'folk pop': 'Pop',
    'french pop': 'Pop', 'hokkien pop': 'Pop', 'hyperpop': 'Pop', 'indian pop': 'Pop', 'indie pop': 'Pop',
    'iranian pop': 'Pop', 'italo dance': 'Pop', 'italo disco': 'Pop', 'j-pop': 'Pop', 'jangle pop': 'Pop',
    'jazz pop': 'Pop', 'k-pop': 'Pop', 'korean hip-hop': 'Pop', 'korean rock': 'Pop', 'latin ballad': 'Pop',
    'latin pop': 'Pop', 'laïkó': 'Pop', 'mandopop': 'Pop', 'mexican pop': 'Pop', 'nederpop': 'Pop',
    'neomelodic music': 'Pop', 'neon pop': 'Pop', 'new pop': 'Pop', 'new romantic': 'Pop',
    'nordic popular music': 'Pop', 'oldies': 'Pop', 'operatic pop': 'Pop', 'opm': 'Pop',
    'orchestral pop': 'Pop', 'palingsound': 'Pop', 'pinoy pop': 'Pop', 'pop': 'Pop', 'pop rap': 'Pop',
    'pop rock': 'Pop', 'pop soul': 'Pop', 'power pop': 'Pop', 'progressive pop': 'Pop',
    'psychedelic pop': 'Pop', 'rebetiko': 'Pop', 'rhythmic adult contemporary': 'Pop',
    'rhythmic contemporary': 'Pop', 'rhythmic oldies': 'Pop', 'russian pop': 'Pop', 'salsa': 'Pop',
    'schlager': 'Pop', 'soft rock': 'Pop', 'sophisti-pop': 'Pop', 'space age pop': 'Pop',
    'sunshine pop': 'Pop', 'surf pop': 'Pop', 'swamp pop': 'Pop', 'synthpop': 'Pop', "t'ong guitar": 'Pop',
    'teen pop': 'Pop', 'traditional pop': 'Pop', 'tropical': 'Pop', 'trot': 'Pop', 'turbo-folk': 'Pop',
    'turkish pop': 'Pop', 'twee pop': 'Pop', 'urban adult contemporary': 'Pop',
    'urban contemporary music': 'Pop', 'vispop': 'Pop', 'wonky pop': 'Pop', 'world': 'Pop', 'yé-yé': 'Pop',

    # Jazz
    'acid jazz': 'Jazz', 'african blues': 'Jazz', 'afro-cuban jazz': 'Jazz', 'alt-jazz': 'Jazz',
    'alternative r&b': 'Jazz', 'anatolian blues': 'Jazz', 'avant-garde jazz': 'Jazz', 'bebop': 'Jazz',
    'big band': 'Jazz', 'blue-eyed soul': 'Jazz', 'blues': 'Jazz', 'blues rock': 'Jazz', 'boogie': 'Jazz',
    'boogie-woogie': 'Jazz', 'bossa nova': 'Jazz', 'brazilian jazz': 'Jazz', 'british blues': 'Jazz',
    'british dance band': 'Jazz', 'british rhythm and blues': 'Jazz', 'british soul': 'Jazz',
    'brown-eyed soul': 'Jazz', 'canadian blues': 'Jazz', 'cape jazz': 'Jazz', 'chamber jazz': 'Jazz',
    'chicago blues': 'Jazz', 'christian r&b': 'Jazz', 'cinematic soul': 'Jazz',
    'classic female blues': 'Jazz', 'contemporary r&b': 'Jazz', 'continental jazz': 'Jazz',
    'cool jazz': 'Jazz', 'country blues': 'Jazz', 'crossover jazz': 'Jazz', 'deep funk': 'Jazz',
    'delta blues': 'Jazz', 'desert blues': 'Jazz', 'detroit blues': 'Jazz', 'disco': 'Jazz',
    'dixieland': 'Jazz', 'doo-wop': 'Jazz', 'electric blues': 'Jazz', 'ethno jazz': 'Jazz',
    'european free jazz': 'Jazz', 'free funk': 'Jazz', 'free improvisation': 'Jazz', 'free jazz': 'Jazz',
    'freestyle': 'Jazz', 'funk': 'Jazz', 'fusion': 'Jazz', 'go-go': 'Jazz', 'gospel blues': 'Jazz',
    'gospel music': 'Jazz', 'gypsy jazz': 'Jazz', 'hard bop': 'Jazz', 'hill country blues': 'Jazz',
    'hip-hop soul': 'Jazz', 'hokum blues': 'Jazz', 'jazz': 'Jazz', 'jazz blues': 'Jazz',
    'jazz fusion': 'Jazz', 'jazz rap': 'Jazz', 'jazz rock': 'Jazz', 'jazz-funk': 'Jazz',
    'jazztronica': 'Jazz', 'jump blues': 'Jazz', 'kansas city blues': 'Jazz', 'kansas city jazz': 'Jazz',
    'latin jazz': 'Jazz', 'latin r&b': 'Jazz', 'livetronica': 'Jazz', 'louisiana blues': 'Jazz',
    'm-base': 'Jazz', 'mainstream jazz': 'Jazz', 'memphis blues': 'Jazz', 'minneapolis sound': 'Jazz',
    'modal jazz': 'Jazz', 'neo soul': 'Jazz', 'neo-bop jazz': 'Jazz', 'neo-swing': 'Jazz',
    'new jack swing': 'Jazz', 'new orleans blues': 'Jazz', 'new orleans rhythm and blues': 'Jazz',
    'new zealand blues': 'Jazz', 'northern soul': 'Jazz', 'nu jazz': 'Jazz', 'orchestral jazz': 'Jazz',
    'piedmont blues': 'Jazz', 'post-bop': 'Jazz', 'progressive jazz': 'Jazz', 'progressive soul': 'Jazz',
    'psychedelic funk': 'Jazz', 'psychedelic soul': 'Jazz', 'punk blues': 'Jazz', 'punk jazz': 'Jazz',
    'quiet storm': 'Jazz', 'r&b': 'Jazz', 'retro-soul': 'Jazz', 'rhythm and blues': 'Jazz',
    'samba-jazz': 'Jazz', 'shibuya-kei': 'Jazz', 'ska jazz': 'Jazz', 'smooth jazz': 'Jazz',
    'smooth soul': 'Jazz', 'soul': 'Jazz', 'soul blues': 'Jazz', 'soul jazz': 'Jazz',
    'southern gospel': 'Jazz', 'southern soul': 'Jazz', 'st. louis blues': 'Jazz',
    'straight-ahead jazz': 'Jazz', 'stride jazz': 'Jazz', 'swamp blues': 'Jazz', 'synth-funk': 'Jazz',
    'talking blues': 'Jazz', 'texas blues': 'Jazz', 'third stream': 'Jazz',
    'urban contemporary gospel': 'Jazz', 'vocal jazz': 'Jazz', 'west coast blues': 'Jazz',
    'west coast jazz': 'Jazz',

    # Classical
    '20th-century classical music': 'Classical', '21st-century classical music': 'Classical',
    'andalusian classical music': 'Classical', 'ars antiqua': 'Classical', 'ars nova': 'Classical',
    'ars subtilior': 'Classical', 'baroque': 'Classical', 'baroque music': 'Classical', 'cello': 'Classical',
    'chamber music': 'Classical', 'classical': 'Classical', 'classical period': 'Classical',
    'classical period (music)': 'Classical', 'common practice period': 'Classical', 'concerto': 'Classical',
    'contemporary classical': 'Classical', 'contemporary classical music': 'Classical',
    'early music': 'Classical', 'experimental music': 'Classical', 'film score': 'Classical',
    'galant music': 'Classical', 'high modernism': 'Classical', 'impressionism in music': 'Classical',
    'impressionist': 'Classical', 'indian classical music': 'Classical', 'korean court music': 'Classical',
    'kurdish classical music': 'Classical', 'medieval music': 'Classical', 'minimal music': 'Classical',
    'minimalist': 'Classical', 'modern classical': 'Classical', 'modernism (music)': 'Classical',
    'neoclassicism (music)': 'Classical', 'opera': 'Classical', 'orchestral': 'Classical',
    'ottoman music': 'Classical', 'persian classical music': 'Classical', 'piano': 'Classical',
    'postmodern music': 'Classical', 'renaissance music': 'Classical', 'romantic': 'Classical',
    'romantic music': 'Classical', 'soundtrack': 'Classical', 'symphony': 'Classical', 'violin': 'Classical',
    'western classical music': 'Classical',
}


# API keys come from the environment, never from this file. A key written into
# source is a burned key: scrapers find public ones within minutes, and even in a
# private repo the secret lands in every clone and every backup of it.
#
#   export LASTFM_API_KEY=...     https://www.last.fm/api/account/create
#   export ACOUSTID_API_KEY=...   https://acoustid.org/new-application
LASTFM_API_KEY = os.environ.get("LASTFM_API_KEY", "")
ACOUSTID_API_KEY = os.environ.get("ACOUSTID_API_KEY", "")

# Initialize MusicBrainz
musicbrainzngs.set_useragent("MusicGenreSorter", "1.0", "your-email@example.com")



def load_genres_map() -> dict:
    """Load genres mapping from JSON file."""
    if os.path.exists(GENRES_MAP_FILE):
        try:
            with open(GENRES_MAP_FILE, 'r') as f:
                return json.load(f)
        except json.JSONDecodeError:
            logger.warning("Genres map file corrupted, using defaults")
    return DEFAULT_GENRES_MAP.copy()


def save_genres_map(genres_map: dict):
    """Save genres mapping to JSON file."""
    try:
        with open(GENRES_MAP_FILE, 'w') as f:
            json.dump(genres_map, f, indent=2)
    except Exception as e:
        logger.error(f"Failed to save genres map: {e}")


def parse_filename(filename: str) -> Tuple[Optional[str], Optional[str]]:
    """Parse artist and track from filename."""
    # Remove extension
    name = Path(filename).stem

    # Some download sources (e.g. VK audio grabbers) replace spaces with underscores
    # in the whole filename -- normalize before separator matching so
    # "SDP_-_Syp_garmonika_80591268" is treated the same as "SDP - Syp garmonika".
    normalized = re.sub(r'\s+', ' ', name.replace('_', ' ')).strip()

    artist, track = None, normalized
    separators = [' - ', ' – ', ' — ', ' | ', ' / ']
    for sep in separators:
        if sep in normalized:
            parts = normalized.split(sep, 1)
            if len(parts) == 2:
                artist, track = parts[0].strip(), parts[1].strip()
                break

    # Strip a trailing standalone numeric ID some download tools append to the
    # track title (e.g. an internal VK audio id) -- legitimate years/track numbers
    # in real titles are rarely 5+ digits, so this is a safe cutoff.
    track = re.sub(r'\s+\d{5,}$', '', track).strip()

    return artist, track


def get_metadata(file_path: str) -> Optional[str]:
    """Extract genre from file metadata using mutagen."""
    try:
        audio = MutagenFile(file_path)
        if audio is None:
            return None

        # Check different tag formats
        genre = None
        if hasattr(audio, 'tags') and audio.tags:
            # MP3
            if isinstance(audio, MP3):
                genre = audio.tags.get('TCON')
            # FLAC
            elif isinstance(audio, FLAC):
                genre = audio.tags.get('GENRE', [None])[0]
            # MP4/M4A
            elif isinstance(audio, MP4):
                genre = audio.tags.get('\xa9gen', [None])[0]

        if genre:
            return str(genre).lower()
    except Exception as e:
        logger.warning(f"Failed to read metadata for {file_path}: {e}")

    return None


def search_musicbrainz_recordings(artist: str, track: str, limit: int = 8) -> list:
    """Search MusicBrainz for candidate recordings. Returns up to `limit` raw matches."""
    try:
        result = musicbrainzngs.search_recordings(artist=artist, recording=track, limit=limit)
        return result.get('recording-list') or []
    except Exception as e:
        logger.warning(f"MusicBrainz search failed for {artist} - {track}: {e}")
        return []


def search_musicbrainz_recording(artist: str, track: str) -> Optional[dict]:
    """Search MusicBrainz for MusicBrainz's own single top-ranked recording, or None."""
    recordings = search_musicbrainz_recordings(artist, track, limit=1)
    return recordings[0] if recordings else None


def search_musicbrainz(artist: str, track: str) -> Optional[str]:
    """Search MusicBrainz for genre information."""
    recording = search_musicbrainz_recording(artist, track)
    if not recording:
        return None

    try:
        # Tags aren't included in search results — fetch them for the top match.
        time.sleep(1)
        full = musicbrainzngs.get_recording_by_id(recording['id'], includes=['tags'])
        for tag in full.get('recording', {}).get('tag-list', []):
            tag_name = tag['name'].lower()
            if tag_name in DEFAULT_GENRES_MAP:
                return DEFAULT_GENRES_MAP[tag_name]
    except Exception as e:
        logger.warning(f"MusicBrainz tag lookup failed for {artist} - {track}: {e}")

    return None


def _text_similarity(a: str, b: str) -> float:
    """Fuzzy text similarity, robust to Cyrillic vs. transliterated-Latin filenames
    (MusicBrainz often stores Russian titles in Cyrillic while filenames use Latin transliteration)."""
    norm = lambda s: re.sub(r'[^\w\s]', '', s.lower()).strip()
    direct = difflib.SequenceMatcher(None, norm(a), norm(b)).ratio()
    translit = difflib.SequenceMatcher(None, norm(unidecode(a)), norm(unidecode(b))).ratio()
    return max(direct, translit)


_IDENTIFY_MIN_TITLE_SIMILARITY = 0.55
_IDENTIFY_MIN_ARTIST_SIMILARITY = 0.5


def _try_identify(artist: str, track: str) -> Optional[dict]:
    """Search several MusicBrainz candidates and pick the one our own title/artist
    similarity likes best.

    MusicBrainz's own relevance score (ext:score) turned out to be an unreliable
    ranking signal for this: testing found the *correct* exact-title match scored
    lower (79) than a wrong same-artist compilation track (100) for the same
    query. Looking only at the single top-ranked hit (the original approach)
    means the right answer is often sitting a few places down in the results and
    never gets seen. Fetching a batch of candidates and ranking them ourselves by
    text similarity fixes that, while the similarity thresholds still guard
    against a confident-looking wrong match.
    """
    best, best_combined = None, -1.0
    for recording in search_musicbrainz_recordings(artist, track):
        canonical_title = recording.get('title', '')
        artist_credit = recording.get('artist-credit') or [{}]
        canonical_artist = artist_credit[0].get('artist', {}).get('name') or recording.get('artist-credit-phrase', '')
        if not canonical_title or not canonical_artist:
            continue

        title_similarity = _text_similarity(track, canonical_title)
        artist_similarity = _text_similarity(artist, canonical_artist)
        if title_similarity < _IDENTIFY_MIN_TITLE_SIMILARITY or artist_similarity < _IDENTIFY_MIN_ARTIST_SIMILARITY:
            continue

        combined = title_similarity + artist_similarity
        if combined > best_combined:
            best_combined = combined
            best = {'artist': canonical_artist, 'title': canonical_title,
                    'score': int(recording.get('ext:score', 0)),
                    'title_similarity': round(title_similarity, 2),
                    'artist_similarity': round(artist_similarity, 2)}

    return best


_ACOUSTID_MIN_SCORE = 0.5


def identify_track_via_acoustid(file_path: str) -> Optional[dict]:
    """Identify a track by its audio fingerprint (Chromaprint/AcoustID) instead of
    filename text.

    This is a last-resort fallback for when the filename's artist/title guess is
    wrong enough that no text search could ever find the right recording (as
    opposed to just being mistransliterated, which the Cyrillic retry above
    handles). Fingerprinting matches the actual audio content, independent of
    what the file happens to be named.

    Requires the `fpcalc` binary (`brew install chromaprint`) and an AcoustID
    *application* API key, registered at https://acoustid.org/new-application.

    Note the two key types are easy to mix up: https://acoustid.org/api-key
    hands out a *user* key, which is only good for submitting new fingerprints
    and is rejected by the lookup endpoint with "invalid API key". The lookup
    call below needs the application key.

    Silently does nothing when the key is missing, same as the Last.fm check.
    """
    if not HAS_ACOUSTID:
        return None
    if not ACOUSTID_API_KEY or ACOUSTID_API_KEY == "YOUR_ACOUSTID_API_KEY":
        return None

    try:
        results = acoustid.match(ACOUSTID_API_KEY, file_path, meta=['recordings'])
        for score, _recording_id, title, artist in results:
            if score is None or score < _ACOUSTID_MIN_SCORE:
                continue
            if not title or not artist:
                continue
            return {'artist': artist, 'title': title, 'score': round(score * 100), 'source': 'acoustid'}
    except acoustid.NoBackendError:
        logger.warning("AcoustID: fpcalc binary not found on PATH (brew install chromaprint)")
    except acoustid.FingerprintGenerationError as e:
        logger.warning(f"AcoustID fingerprinting failed for {file_path}: {e}")
    except acoustid.WebServiceError as e:
        # A rejected key surfaces as a generic "status: error", which reads like
        # a network hiccup unless it is called out explicitly.
        logger.warning(
            f"AcoustID web service error for {file_path}: {e}. If this repeats for every "
            f"file, the key is probably a user key from acoustid.org/api-key rather than "
            f"an application key from acoustid.org/new-application."
        )
    except Exception as e:
        logger.warning(f"AcoustID lookup failed for {file_path}: {e}")

    return None


def identify_track(artist: str, track: str, file_path: Optional[str] = None) -> Optional[dict]:
    """Look up the canonical artist/title for a (possibly mangled) filename guess.

    Only returns a result when confident: MusicBrainz's own match score is high,
    AND the returned title is similar to what we searched for, AND the returned
    artist is similar too. Title alone isn't enough — e.g. searching for a remix
    can text-match "(Extended Mix)" on a completely different artist's track.
    """
    match = _try_identify(artist, track)
    if match:
        return match

    # A plain-ASCII query is often a Latin transliteration of a non-Latin original
    # (e.g. Russian filenames from some download sources). MusicBrainz's own fuzzy
    # search frequently fails to cross-match that against a Cyrillic-titled
    # recording even when it's in the database — verified directly: searching
    # "Kukla kolduna" finds nothing usable, but the transliterated "Кукла
    # колдуна" finds the exact match at 100% score. Retry with a Cyrillic
    # transliteration as a fallback; the confidence gates above still protect
    # against a wrong guess if the artist's real name turns out to be Latin
    # after all (stylized band names, etc.).
    if artist.isascii() and track.isascii():
        time.sleep(1)
        match = _try_identify(translit(artist, 'ru'), translit(track, 'ru'))
        if match:
            return match

    # Last resort: identify by audio fingerprint instead of filename text at all.
    # Covers cases where the filename's artist/title guess isn't just mangled but
    # outright wrong (or missing), so no text search variant could ever find it.
    if file_path:
        match = identify_track_via_acoustid(file_path)
        if match:
            return match

    return None


_FILENAME_UNSAFE_CHARS = re.compile(r'[\\/:*?"<>|]')


def apply_filename_fix(file_path: str, canonical_artist: str, canonical_title: str) -> str:
    """Rename file_path to "Artist - Title.ext" and write matching ID3/tag fields. Returns the new path."""
    path = Path(file_path)
    safe_name = _FILENAME_UNSAFE_CHARS.sub('', f"{canonical_artist} - {canonical_title}").strip()
    new_path = str(path.with_name(f"{safe_name}{path.suffix}"))

    if new_path != file_path:
        os.rename(file_path, new_path)

    try:
        ext = path.suffix.lower()
        if ext == '.mp3':
            try:
                tags = EasyID3(new_path)
            except ID3NoHeaderError:
                tags = MutagenFile(new_path, easy=True)
                tags.add_tags()
            tags['artist'] = canonical_artist
            tags['title'] = canonical_title
            tags.save()
        elif ext == '.flac':
            audio = FLAC(new_path)
            audio['artist'] = canonical_artist
            audio['title'] = canonical_title
            audio.save()
        elif ext == '.m4a':
            audio = MP4(new_path)
            audio['\xa9ART'] = canonical_artist
            audio['\xa9nam'] = canonical_title
            audio.save()
    except Exception as e:
        logger.warning(f"Failed to write tags for {new_path}: {e}")

    return new_path


def search_lastfm(artist: str, track: str) -> Optional[str]:
    """Search Last.fm for genre information."""
    if not LASTFM_API_KEY or LASTFM_API_KEY == "YOUR_LASTFM_API_KEY":
        return None

    try:
        url = "http://ws.audioscrobbler.com/2.0/"
        params = {
            'method': 'track.getInfo',
            'artist': artist,
            'track': track,
            'api_key': LASTFM_API_KEY,
            'format': 'json'
        }
        response = requests.get(url, params=params, timeout=10)
        response.raise_for_status()
        data = response.json()

        if 'track' in data and 'toptags' in data['track']:
            for tag in data['track']['toptags']['tag']:
                genre = tag['name'].lower()
                if genre in DEFAULT_GENRES_MAP:
                    return DEFAULT_GENRES_MAP[genre]
    except Exception as e:
        logger.warning(f"Last.fm search failed for {artist} - {track}: {e}")

    return None


# Hand-tuned reference points for the nearest-centroid genre fallback below. Not a
# trained model — just rough typical values per feature so a successful analysis
# always picks *some* genre instead of bailing out to 'Unknown'.
#
# Recalibrated against measured features from real tracks (critical-test pass):
# rms_std (RMS dynamic-range variability) was dropped entirely — it turned out to
# reflect mastering/loudness more than genre, real-world values (0.03-0.17) were far
# outside the originally-assumed range (0.03-0.09), and it was dominating the
# distance calculation and systematically over-predicting 'Rock'. Dropping it and
# widening the zcr scale to match real-world ranges roughly doubled accuracy on a
# small hand-labeled real-track sample (2/9 -> 4/9). Hip-Hop remains the weakest
# category: its spectral range (lo-fi boom-bap vs. bright trap) is too wide for one
# centroid to capture — a known, honest limitation of this heuristic approach.
_GENRE_CENTROIDS = {
    'Hip-Hop':    {'tempo': 90,  'centroid': 2200, 'bandwidth': 2200, 'zcr': 0.07},
    'Electronic': {'tempo': 135, 'centroid': 3100, 'bandwidth': 2600, 'zcr': 0.13},
    'Rock':       {'tempo': 130, 'centroid': 2600, 'bandwidth': 2500, 'zcr': 0.11},
    'Pop':        {'tempo': 105, 'centroid': 2300, 'bandwidth': 2300, 'zcr': 0.09},
    'Jazz':       {'tempo': 110, 'centroid': 1900, 'bandwidth': 1900, 'zcr': 0.05},
    'Classical':  {'tempo': 90,  'centroid': 1500, 'bandwidth': 1600, 'zcr': 0.03},
}
_GENRE_FEATURE_SCALES = {'tempo': 40, 'centroid': 700, 'bandwidth': 600, 'zcr': 0.05}


def analyze_audio_librosa(file_path: str) -> Optional[str]:
    """Analyze audio using librosa and a nearest-centroid classification over top-level genres."""
    try:
        y, sr = librosa.load(file_path, duration=60)

        tempo = detect_bpm(y, sr) or 120
        spectral_centroid = float(np.mean(librosa.feature.spectral_centroid(y=y, sr=sr)))
        spectral_bandwidth = float(np.mean(librosa.feature.spectral_bandwidth(y=y, sr=sr)))
        zcr = float(np.mean(librosa.feature.zero_crossing_rate(y=y)))

        features = {'tempo': tempo, 'centroid': spectral_centroid, 'bandwidth': spectral_bandwidth, 'zcr': zcr}

        best_genre, best_distance = 'Unknown', float('inf')
        for genre, centroid in _GENRE_CENTROIDS.items():
            distance = sum(
                ((features[key] - centroid[key]) / _GENRE_FEATURE_SCALES[key]) ** 2
                for key in centroid
            )
            if distance < best_distance:
                best_genre, best_distance = genre, distance

        return best_genre

    except Exception as e:
        logger.warning(f"Audio analysis failed for {file_path}: {e}")
        return None


# ---------------------------------------------------------------------------
# Audio processing: BPM, Camelot key, and LUFS loudness normalization.
# ---------------------------------------------------------------------------

_BPM_MIN = 40
# 200 covers the vast majority of real music (including up-tempo electronic/drum &
# bass at 170-180) while excluding a range where testing found real (non-extreme)
# tracks occasionally producing a spurious, much stronger peak at 2x their true
# tempo -- e.g. a ~101 BPM track's tempogram peaking at 206.7. Genuinely 200+ BPM
# genres (speedcore, some hardcore) are a rare enough minority in a typical DJ
# library that this tradeoff comes out ahead in practice.
_BPM_MAX = 200


def detect_bpm(y: np.ndarray, sr: int) -> Optional[int]:
    """Estimate BPM from the strongest peak in the mean tempogram.

    librosa's convenience `feature.tempo()` applies a log-normal prior centered on
    120 BPM (its `start_bpm`/`std_bpm` defaults), which systematically halves fast
    tempos (~170-200+ BPM) — confirmed via synthetic click-track testing where the
    *raw* tempogram's tallest peak was consistently the correct tempo, but the
    prior-biased convenience function (and librosa.beat.beat_track, which shares
    the same bias) picked the sub-harmonic instead. Reading the tempogram directly
    and taking its tallest peak avoids that bias and rounds to a whole BPM.

    Note: real music can still land on a fast subdivision (hi-hats, syllable rate)
    instead of the true beat, and testing showed peak-strength ratios alone can't
    reliably tell that apart from a genuinely fast track — both patterns produce
    a similar 80-95% strength ratio between the true tempo and its double. A
    blanket "prefer the slower candidate" rule was tried and rejected: it fixed a
    couple of real tracks but broke the well-validated 170-200 BPM synthetic cases
    (27/28 -> 16/28 in testing). No reliable general fix was found; this remains a
    known limitation for tracks with strong sub-beat energy.
    """
    try:
        onset_env = librosa.onset.onset_strength(y=y, sr=sr)
        if not np.any(onset_env):
            return None

        hop_length = 512
        tempogram = librosa.feature.tempogram(onset_envelope=onset_env, sr=sr,
                                               hop_length=hop_length, win_length=384)
        mean_tg = np.mean(tempogram, axis=1)
        bpms = librosa.tempo_frequencies(len(mean_tg), sr=sr, hop_length=hop_length)

        valid = (bpms >= _BPM_MIN) & (bpms <= _BPM_MAX)
        bpms_v, tg_v = bpms[valid], mean_tg[valid]
        if len(bpms_v) == 0:
            return None
        order = np.argsort(bpms_v)
        bpms_v, tg_v = bpms_v[order], tg_v[order]

        peaks, _ = scipy.signal.find_peaks(tg_v)
        if len(peaks) == 0:
            return round(float(bpms_v[np.argmax(tg_v)]))

        best = max(peaks, key=lambda i: tg_v[i])
        return round(float(bpms_v[best]))
    except Exception as e:
        logger.warning(f"BPM detection failed: {e}")
        return None


# Krumhansl-Schmuckler key profiles, indexed starting at the tonic (C, C#, D, ...).
_KS_MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_KS_MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

# Camelot wheel: pitch-class index (0=C .. 11=B) -> Camelot code.
_CAMELOT_MAJOR = {0: '8B', 7: '9B', 2: '10B', 9: '11B', 4: '12B', 11: '1B',
                  6: '2B', 1: '3B', 8: '4B', 3: '5B', 10: '6B', 5: '7B'}
_CAMELOT_MINOR = {9: '8A', 4: '9A', 11: '10A', 6: '11A', 1: '12A', 8: '1A',
                  3: '2A', 10: '3A', 5: '4A', 0: '5A', 7: '6A', 2: '7A'}


# Minimum Krumhansl-Schmuckler correlation to trust a key result. Calibrated against
# real tracks (0.57-0.82 for tonal music, down to 0.31 for beat-heavy/percussive hip-hop
# with little harmonic content) vs. synthetic white noise (0.53) -- below this, there's
# no clear tonal center to report and guessing a specific key would just be wrong more
# often than not.
_KEY_MIN_CONFIDENCE = 0.55


def detect_key(y: np.ndarray, sr: int) -> Tuple[Optional[str], Optional[float]]:
    """Estimate the musical key via chroma correlation. Returns (camelot_code, confidence)
    -- confidence is the Krumhansl-Schmuckler correlation of the winning key (0-1ish;
    real music tops out around 0.8-0.85), so callers can show *why* a key was accepted
    or skipped rather than just a bare code or None. camelot_code is None when confidence
    falls below _KEY_MIN_CONFIDENCE, but the confidence value itself is always returned
    so the caller can log it either way."""
    try:
        chroma = np.mean(librosa.feature.chroma_cqt(y=y, sr=sr), axis=1)
        if not np.any(chroma):
            return None, None

        best_score, best_pitch, best_mode = -np.inf, 0, 'major'
        for shift in range(12):
            rotated = np.roll(chroma, -shift)
            major_score = np.corrcoef(rotated, _KS_MAJOR_PROFILE)[0, 1]
            minor_score = np.corrcoef(rotated, _KS_MINOR_PROFILE)[0, 1]
            if np.isfinite(major_score) and major_score > best_score:
                best_score, best_pitch, best_mode = major_score, shift, 'major'
            if np.isfinite(minor_score) and minor_score > best_score:
                best_score, best_pitch, best_mode = minor_score, shift, 'minor'

        confidence = round(float(best_score), 3)
        if best_score < _KEY_MIN_CONFIDENCE:
            return None, confidence

        table = _CAMELOT_MAJOR if best_mode == 'major' else _CAMELOT_MINOR
        return table.get(best_pitch), confidence
    except Exception as e:
        logger.warning(f"Key detection failed: {e}")
        return None, None


def _load_audio_for_analysis(file_path: str) -> Tuple[np.ndarray, int]:
    """Load audio as float32 samples shaped (n_samples, n_channels) at the file's native rate.

    Tries libsndfile first (handles WAV/FLAC/OGG/MP3 directly); falls back to piping
    through ffmpeg for formats it can't decode (e.g. M4A/AAC), using mutagen to recover
    the true channel count since raw ffmpeg PCM output doesn't carry that information.
    """
    try:
        data, sr = sf.read(file_path, dtype='float32', always_2d=True)
        return data, sr
    except Exception:
        pass

    info = MutagenFile(file_path)
    channels = getattr(info.info, 'channels', 2) if info and info.info else 2
    sr = getattr(info.info, 'sample_rate', 44100) if info and info.info else 44100

    args = [FFMPEG_EXE, '-v', 'error', '-i', file_path, '-f', 'f32le', '-acodec', 'pcm_f32le', '-']
    result = subprocess.run(args, capture_output=True, timeout=120)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg decode failed: {result.stderr.decode(errors='ignore')}")

    raw = np.frombuffer(result.stdout, dtype=np.float32)
    channels = max(1, channels)
    raw = raw[: len(raw) - (len(raw) % channels)].reshape(-1, channels)
    return raw, sr


def measure_loudness(data: np.ndarray, sr: int) -> dict:
    """Measure integrated loudness, short-term max loudness, and true peak (per ITU-R BS.1770)."""
    meter = pyloudnorm.Meter(sr)

    try:
        integrated = meter.integrated_loudness(data)
    except Exception:
        integrated = float('-inf')

    # Short-term max: slide an ungated 3s window with a 1s hop and take the loudest one.
    window_samples = int(3.0 * sr)
    hop_samples = int(1.0 * sr)
    short_term_values = []
    n = data.shape[0]
    if n >= window_samples:
        for start in range(0, n - window_samples + 1, hop_samples):
            try:
                loudness = meter.integrated_loudness(data[start:start + window_samples])
            except Exception:
                continue
            if np.isfinite(loudness):
                short_term_values.append(loudness)
    short_term_max = max(short_term_values) if short_term_values else integrated

    # True peak: 4x oversample then take the max absolute sample.
    try:
        oversampled = scipy.signal.resample_poly(data, up=4, down=1, axis=0)
        peak_amplitude = float(np.max(np.abs(oversampled))) if oversampled.size else 0.0
    except Exception:
        peak_amplitude = float(np.max(np.abs(data))) if data.size else 0.0
    true_peak_db = 20 * np.log10(peak_amplitude) if peak_amplitude > 0 else -120.0

    return {
        'integrated': float(integrated) if np.isfinite(integrated) else None,
        'short_term_max': float(short_term_max) if np.isfinite(short_term_max) else None,
        'true_peak': float(true_peak_db),
    }


_SAFE_LIMITER_TP_DB = -1.0
_SILENCE_THRESHOLD_DB = -80


def _build_render_filters(gain_db: float, safe_limiter: bool, remove_silence: bool) -> list:
    filters = []
    if abs(gain_db) > 0.01:
        filters.append(f"volume={gain_db:.3f}dB")
    if safe_limiter:
        limit_linear = 10 ** (_SAFE_LIMITER_TP_DB / 20)
        filters.append(f"alimiter=limit={limit_linear:.6f}:level=disabled")
    if remove_silence:
        # Small margin at the start, longer margin at the end to preserve natural decay/reverb tails.
        filters.append(
            f"silenceremove=start_periods=1:start_duration=0.05:start_threshold={_SILENCE_THRESHOLD_DB}dB:"
            f"stop_periods=1:stop_duration=0.3:stop_threshold={_SILENCE_THRESHOLD_DB}dB"
        )
    return filters


def render_audio_file(input_path: str, output_path: str, gain_db: float, safe_limiter: bool,
                       remove_silence: bool, output_format: str, sample_rate) -> None:
    """Render a processed copy of input_path via ffmpeg: gain, limiter, silence trim, format/rate."""
    filters = _build_render_filters(gain_db, safe_limiter, remove_silence)
    args = [FFMPEG_EXE, '-y', '-v', 'error', '-i', input_path]
    if filters:
        args += ['-af', ','.join(filters)]
    if sample_rate and str(sample_rate) != 'same':
        args += ['-ar', str(sample_rate)]
    if output_format == 'mp3':
        args += ['-codec:a', 'libmp3lame', '-b:a', '320k']
    elif output_format == 'wav':
        args += ['-codec:a', 'pcm_s16le']
    args.append(output_path)

    result = subprocess.run(args, capture_output=True, timeout=300)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.decode(errors='ignore'))


def _format_lufs(value: float) -> str:
    return f"{value:g}"


def normalize_genre(genre: Optional[str], genres_map: dict) -> str:
    """Normalize genre to standard categories."""
    if not genre:
        return 'Unknown'

    genre_lower = genre.lower()
    return genres_map.get(genre_lower, 'Unknown')


def move_file(file_path: str, genre: str, dry_run: bool, output_dir: str):
    """Move file to genre folder."""
    genre_dir = os.path.join(output_dir, genre)
    if not os.path.exists(genre_dir):
        if dry_run:
            logger.info(f"[DRY RUN] Would create directory: {genre_dir}")
        else:
            os.makedirs(genre_dir, exist_ok=True)
            logger.info(f"Created directory: {genre_dir}")

    dest_path = os.path.join(genre_dir, os.path.basename(file_path))

    if dry_run:
        logger.info(f"[DRY RUN] Would move {file_path} to {dest_path}")
    else:
        try:
            shutil.move(file_path, dest_path)
            logger.info(f"Moved {file_path} to {dest_path}")
        except Exception as e:
            logger.error(f"Failed to move {file_path}: {e}")


# Cache of (artist, track) -> genre lookups, to avoid repeat network calls
# for the same track within a run (or across runs on the same folder).
_GENRE_LOOKUP_CACHE: dict = {}


def process_file(file_path: str, genres_map: dict, dry_run: bool, output_dir: str) -> str:
    """Process a single file and determine its genre."""
    # 1. Try metadata
    genre = get_metadata(file_path)
    if genre:
        genre = normalize_genre(genre, genres_map)
        if genre != 'Unknown':
            return genre

    # 2. Parse filename for artist/track
    artist, track = parse_filename(file_path)
    if artist and track:
        cache_key = (artist.lower(), track.lower())
        cached = _GENRE_LOOKUP_CACHE.get(cache_key)
        if cached:
            return cached

        # Search MusicBrainz
        genre = search_musicbrainz(artist, track)
        if not genre:
            # Rate limit
            time.sleep(1)
            # Search Last.fm
            genre = search_lastfm(artist, track)

        if genre:
            _GENRE_LOOKUP_CACHE[cache_key] = genre
            return genre

        # Rate limit before falling through to audio analysis
        time.sleep(1)

    # 3. Audio analysis
    genre = analyze_audio_librosa(file_path)
    if genre:
        return genre

    # Default
    return 'Unknown'


def sort_music(input_dir: str, dry_run: bool = False, output_dir: str = SORTED_DIR,
               max_files: int = None, progress_callback=None):
    """Main sorting function. progress_callback(done, total) is called after each file."""
    output_dir = output_dir or SORTED_DIR
    input_path = Path(input_dir)
    if not input_path.exists():
        logger.error(f"Input directory does not exist: {input_path}")
        return []

    # Find music files
    music_files = []
    for ext in SUPPORTED_EXTENSIONS:
        music_files.extend(input_path.glob(f"**/*{ext}"))

    if not music_files:
        logger.info("No music files found")
        return []

    # Limit files if specified
    if max_files and len(music_files) > max_files:
        music_files = music_files[:max_files]
        logger.info(f"Limited to {max_files} files for processing")

    logger.info(f"Found {len(music_files)} music files")

    # Load genres map
    genres_map = load_genres_map()

    # Process files
    results = []
    total = len(music_files)
    for file_path in tqdm.tqdm(music_files, desc="Processing files"):
        try:
            genre = process_file(str(file_path), genres_map, dry_run, output_dir)
            move_file(str(file_path), genre, dry_run, output_dir)
            results.append({'file': str(file_path), 'genre': genre})
        except Exception as e:
            logger.error(f"Failed to process {file_path}: {e}")
            results.append({'file': str(file_path), 'genre': 'Error'})
        if progress_callback:
            progress_callback(len(results), total)

    return results


def process_track(file_path: str, steps: dict, genres_map: dict, output_dir: str,
                   dry_run: bool, loudness_opts: dict) -> dict:
    """Run the selected steps once for a single file: fix names, sort by genre,
    detect BPM/key, normalize loudness — sharing one audio decode across all of them."""
    result = {
        'original_file': file_path,
        'identified_as': None,
        'genre': None,
        'bpm': None,
        'key': None,
        'key_confidence': None,
        'loudness_mode': None,
        'measured_lufs': None,
        'target_lufs': None,
        'true_peak_before_db': None,
        'gain_db': None,
        'output_file': file_path,
    }
    current_path = file_path

    if steps.get('fix_names'):
        artist, track = parse_filename(current_path)
        if artist and track:
            match = identify_track(artist, track, current_path)
            if match:
                try:
                    current_path = apply_filename_fix(current_path, match['artist'], match['title'])
                    result['identified_as'] = f"{match['artist']} - {match['title']}"
                except Exception as e:
                    logger.error(f"Failed to rename {current_path}: {e}")

    audio_data, audio_sr, mono = None, None, None
    if steps.get('bpm_key') or steps.get('loudness'):
        try:
            audio_data, audio_sr = _load_audio_for_analysis(current_path)
            mono = np.mean(audio_data, axis=1) if audio_data.ndim > 1 else audio_data
        except Exception as e:
            logger.warning(f"Failed to load audio for {current_path}: {e}")

    if steps.get('bpm_key') and mono is not None:
        result['bpm'] = detect_bpm(mono, audio_sr)
        result['key'], result['key_confidence'] = detect_key(mono, audio_sr)

    genre = None
    if steps.get('sort'):
        genre = process_file(current_path, genres_map, dry_run, output_dir)
        result['genre'] = genre

    final_dir = os.path.join(output_dir, genre) if (steps.get('sort') and genre) else output_dir

    if steps.get('loudness') and audio_data is not None:
        opts = loudness_opts
        gain_db = 0.0
        result['loudness_mode'] = opts['mode']
        result['target_lufs'] = opts['target_lufs'] if opts['mode'] != 'convert_only' else None
        if opts['mode'] in ('short_term', 'integrated'):
            loudness = measure_loudness(audio_data, audio_sr)
            current = loudness['short_term_max'] if opts['mode'] == 'short_term' else loudness['integrated']
            result['measured_lufs'] = round(current, 2) if current is not None else None
            result['true_peak_before_db'] = round(loudness['true_peak'], 2) if loudness.get('true_peak') is not None else None
            if current is not None:
                gain_db = opts['target_lufs'] - current

        stem = Path(current_path).stem
        suffix = Path(current_path).suffix if opts['output_format'] == 'same' else f".{opts['output_format']}"
        prefix = ''
        if opts['add_prefix'] and opts['mode'] == 'short_term':
            prefix = f"[{_format_lufs(opts['target_lufs'])} LUFS-S-max] "
        elif opts['add_prefix'] and opts['mode'] == 'integrated':
            prefix = f"[{_format_lufs(opts['target_lufs'])} LUFS Integrated] "

        os.makedirs(final_dir, exist_ok=True)
        out_path = os.path.join(final_dir, f"{prefix}{stem}{suffix}")
        render_audio_file(current_path, out_path, gain_db, opts['safe_limiter'], opts['remove_silence'],
                           opts['output_format'], opts['sample_rate'])
        result['output_file'] = out_path
        result['gain_db'] = round(gain_db, 2)
    elif steps.get('sort') and genre:
        move_file(current_path, genre, dry_run, output_dir)
        result['output_file'] = os.path.join(final_dir, os.path.basename(current_path))
    else:
        result['output_file'] = current_path

    return result


def is_port_free(port: int, host: str = '127.0.0.1') -> bool:
    """Check if a TCP port is available on the local host."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, port))
            return True
        except OSError:
            return False


def find_free_port(start_port: int = 8000, max_port: int = 8100) -> int:
    """Return the first available port in the given range."""
    for port in range(start_port, max_port + 1):
        if is_port_free(port):
            return port
    raise RuntimeError(f"No available ports found between {start_port} and {max_port}")


# Flask routes
@app.route('/')
def index():
    return render_template_string('''

    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Музыкальный сортир</title>
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
                font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif;
                background: #121212;
                color: #e8e8e8;
                min-height: 100vh;
            }
            .header {
                padding: 22px 16px;
                border-bottom: 1px solid rgba(255,255,255,0.08);
            }
            .header h1 {
                font-size: 1.3em;
                font-weight: 600;
            }
            .header p {
                font-size: 0.85em;
                color: #999;
                margin-top: 4px;
            }
            .container {
                max-width: 720px;
                margin: 0 auto;
                padding: 20px 16px 60px;
            }
            .card {
                background: #1a1a1a;
                border: 1px solid rgba(255,255,255,0.08);
                border-radius: 8px;
                padding: 18px;
                margin-bottom: 14px;
            }
            .card h2 {
                font-size: 0.95em;
                font-weight: 600;
                margin-bottom: 12px;
                display: flex;
                align-items: center;
            }
            .step-num {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 20px;
                height: 20px;
                border-radius: 50%;
                background: rgba(255,255,255,0.1);
                font-size: 0.72em;
                margin-right: 8px;
                flex-shrink: 0;
            }
            input[type=text], input[type=number], select {
                width: 100%;
                padding: 9px 10px;
                border: 1px solid rgba(255,255,255,0.15);
                border-radius: 5px;
                background: #0f0f0f;
                color: #e8e8e8;
                font-size: 0.88em;
            }
            input[type=text]:focus, input[type=number]:focus, select:focus {
                outline: none;
                border-color: #4CAF50;
            }
            .row { display: flex; gap: 8px; margin-top: 8px; }
            button { font-family: inherit; cursor: pointer; border: none; border-radius: 5px; }
            .btn {
                padding: 9px 14px;
                background: rgba(255,255,255,0.08);
                color: #e8e8e8;
                font-size: 0.85em;
                flex: 1;
            }
            .btn:hover { background: rgba(255,255,255,0.14); }
            .btn-primary {
                width: 100%;
                padding: 13px;
                background: #4CAF50;
                color: #0f0f0f;
                font-weight: 600;
                font-size: 0.95em;
            }
            .btn-primary:hover { background: #5cbf60; }
            .btn-primary:disabled { opacity: 0.6; cursor: default; }
            .status-text { font-size: 0.8em; color: #999; margin-top: 8px; }
            .process-row {
                border: 1px solid rgba(255,255,255,0.08);
                border-radius: 6px;
                padding: 12px 14px;
                margin-bottom: 8px;
            }
            .process-row:last-child { margin-bottom: 0; }
            .process-head {
                display: flex;
                justify-content: space-between;
                align-items: center;
                cursor: pointer;
            }
            .process-title { font-size: 0.9em; font-weight: 600; }
            .process-desc { font-size: 0.78em; color: #999; margin-top: 2px; }
            .switch {
                width: 36px;
                height: 20px;
                border-radius: 10px;
                background: rgba(255,255,255,0.15);
                position: relative;
                flex-shrink: 0;
                margin-left: 12px;
            }
            .switch.on { background: #4CAF50; }
            .switch .knob {
                width: 16px;
                height: 16px;
                border-radius: 50%;
                background: #fff;
                position: absolute;
                top: 2px;
                left: 2px;
            }
            .switch.on .knob { left: 18px; }
            .process-settings {
                margin-top: 12px;
                padding-top: 12px;
                border-top: 1px solid rgba(255,255,255,0.08);
                display: none;
            }
            .process-row.expanded .process-settings { display: block; }
            .field-label { font-size: 0.78em; color: #999; margin-bottom: 4px; display: block; }
            .field { margin-bottom: 10px; }
            .radio-line { display: flex; align-items: flex-start; gap: 8px; padding: 6px 0; cursor: pointer; font-size: 0.85em; }
            .radio-line b { font-weight: 600; }
            .radio-line small { display: block; color: #888; font-size: 0.88em; margin-top: 1px; }
            .checkbox-line { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 0.85em; }
            .segmented { display: flex; border-radius: 5px; overflow: hidden; border: 1px solid rgba(255,255,255,0.15); }
            .segmented button { flex: 1; padding: 7px; background: transparent; color: #ccc; font-size: 0.8em; }
            .segmented button.active { background: #4CAF50; color: #0f0f0f; }
            .progress-track { background: rgba(255,255,255,0.1); border-radius: 4px; height: 6px; overflow: hidden; margin-top: 10px; }
            .progress-fill { background: #4CAF50; height: 100%; width: 0%; transition: width 0.3s; }
            .progress-label { font-size: 0.78em; color: #999; text-align: center; margin-top: 6px; }
            table.results { width: 100%; border-collapse: collapse; font-size: 0.8em; margin-top: 4px; }
            table.results th { text-align: left; color: #999; font-weight: 500; padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,0.08); }
            table.results td { padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,0.05); vertical-align: top; }
            .strike { text-decoration: line-through; color: #777; font-size: 0.85em; }
            .badge { display: inline-block; background: rgba(255,255,255,0.1); padding: 1px 8px; border-radius: 9px; font-size: 0.85em; }
            .link-toggle { font-size: 0.82em; color: #999; cursor: pointer; text-decoration: underline; }
            .genre-map-form { display: flex; gap: 8px; }
            .genre-map-list { max-height: 220px; overflow-y: auto; margin-top: 10px; }
            .genre-map-item {
                background: rgba(255,255,255,0.05);
                padding: 7px 10px;
                margin: 4px 0;
                border-radius: 5px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                font-size: 0.82em;
            }
            .genre-map-item .del-btn { background: transparent; color: #e05353; padding: 2px 6px; font-size: 0.9em; }
            .hidden { display: none; }
            .dev-log {
                background: #0a0a0a;
                border: 1px solid rgba(255,255,255,0.1);
                border-radius: 6px;
                padding: 10px 12px;
                max-height: 260px;
                overflow-y: auto;
                font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
                font-size: 0.78em;
                color: #9fd89f;
                white-space: pre-wrap;
                word-break: break-all;
            }
        </style>
    </head>
    <body>
        <div class="header">
            <h1>Музыкальный сортир</h1>
            <p>Sort, rename, analyze and normalize your music library</p>
        </div>

        <div class="container">

            <div class="card">
                <h2><span class="step-num">1</span>Select music folder</h2>
                <input type="text" id="inputPath" placeholder="/path/to/music/folder">
                <div class="row">
                    <button class="btn" onclick="chooseFolder()">Choose folder</button>
                    <button class="btn" onclick="setInputFolder()">Set folder</button>
                    <button class="btn" onclick="scanFolder()">Scan folder</button>
                </div>
                <div id="inputStatus" class="status-text"></div>
                <div id="fileList" class="status-text"></div>
            </div>

            <div class="card">
                <h2><span class="step-num">2</span>Choose what to run</h2>

                <div class="process-row expanded" data-id="fix_names">
                    <div class="process-head" onclick="toggleProcess('fix_names')">
                        <div>
                            <div class="process-title">Fix filenames and tags</div>
                            <div class="process-desc">Looks up the real artist/title online and renames + retags confident matches.</div>
                        </div>
                        <div class="switch on"><div class="knob"></div></div>
                    </div>
                </div>

                <div class="process-row expanded" data-id="sort">
                    <div class="process-head" onclick="toggleProcess('sort')">
                        <div>
                            <div class="process-title">Sort by genre</div>
                            <div class="process-desc">Moves files into genre / subgenre folders.</div>
                        </div>
                        <div class="switch on"><div class="knob"></div></div>
                    </div>
                    <div class="process-settings">
                        <label class="checkbox-line"><input type="checkbox" id="dryRun"> Dry run (preview only, no files moved — ignored if Normalize loudness is also on)</label>
                        <div class="field" style="margin-top:10px;">
                            <label class="field-label">Max files (optional)</label>
                            <input type="number" id="maxFiles" placeholder="Leave empty for all">
                        </div>
                    </div>
                </div>

                <div class="process-row expanded" data-id="bpm_key">
                    <div class="process-head" onclick="toggleProcess('bpm_key')">
                        <div>
                            <div class="process-title">Detect BPM and key</div>
                            <div class="process-desc">Whole-number BPM plus Camelot key for harmonic mixing.</div>
                        </div>
                        <div class="switch on"><div class="knob"></div></div>
                    </div>
                </div>

                <div class="process-row" data-id="loudness">
                    <div class="process-head" onclick="toggleProcess('loudness')">
                        <div>
                            <div class="process-title">Normalize loudness</div>
                            <div class="process-desc">-14 LUFS short-term, -16 LUFS integrated, or convert only.</div>
                        </div>
                        <div class="switch"><div class="knob"></div></div>
                    </div>
                    <div class="process-settings">
                        <label class="radio-line">
                            <input type="radio" name="lufsMode" value="short_term" checked onchange="onLufsModeChange()">
                            <div><b>-14 LUFS (Short-Term Max)</b><small>Best for club / DJ tracks. Loudest 3s window hits -14.</small></div>
                        </label>
                        <label class="radio-line">
                            <input type="radio" name="lufsMode" value="integrated" onchange="onLufsModeChange()">
                            <div><b>-16 LUFS (Integrated)</b><small>Streaming standard. Whole-track average.</small></div>
                        </label>
                        <label class="radio-line">
                            <input type="radio" name="lufsMode" value="convert_only" onchange="onLufsModeChange()">
                            <div><b>Convert only</b><small>Changes format only. Keeps original volume.</small></div>
                        </label>
                        <label class="radio-line">
                            <input type="radio" name="lufsMode" value="custom" onchange="onLufsModeChange()">
                            <div style="flex:1;">
                                <b>Custom target</b><small>Adjustable loudness, -14 to -9 LUFS, short-term.</small>
                                <div id="customTargetRow" style="display:none; align-items:center; gap:8px; margin-top:6px;">
                                    <input type="range" id="customTargetSlider" min="-14" max="-9" step="0.5" value="-9"
                                           oninput="document.getElementById('customTargetValue').innerText = this.value" style="flex:1;">
                                    <span id="customTargetValue">-9</span> LUFS
                                </div>
                            </div>
                        </label>

                        <label class="checkbox-line" style="margin-top:8px;"><input type="checkbox" id="safeLimiter"> Safe limiter (-1.0 dB TP)</label>
                        <label class="checkbox-line"><input type="checkbox" id="removeSilence"> Remove silence (&lt; -80dB)</label>
                        <label class="checkbox-line"><input type="checkbox" id="addPrefix"> Add filename prefix</label>

                        <div class="field" style="margin-top:10px;">
                            <label class="field-label">Output format</label>
                            <div class="segmented">
                                <button type="button" class="active" data-value="same" onclick="selectAudioFormat(this)">Same as source</button>
                                <button type="button" data-value="wav" onclick="selectAudioFormat(this)">WAV</button>
                                <button type="button" data-value="mp3" onclick="selectAudioFormat(this)">MP3</button>
                            </div>
                        </div>
                        <div class="field">
                            <label class="field-label">Sample rate</label>
                            <select id="audioSampleRate">
                                <option value="same">Same as source</option>
                                <option value="44100">44.1 kHz</option>
                                <option value="48000">48 kHz</option>
                            </select>
                        </div>
                    </div>
                </div>
            </div>

            <div class="card">
                <h2><span class="step-num">3</span>Output folder</h2>
                <input type="text" id="outputPath" placeholder="/path/to/output/folder">
                <div class="row">
                    <button class="btn" onclick="chooseOutputFolder()">Choose folder</button>
                </div>
                <div id="outputStatus" class="status-text"></div>
            </div>

            <button class="btn-primary" onclick="startProcessing()">Start processing</button>

            <div id="progressWrap" class="hidden">
                <div class="progress-track"><div id="progressFill" class="progress-fill"></div></div>
                <div id="progressLabel" class="progress-label">0 / 0</div>
            </div>

            <div class="link-toggle" style="margin-top:10px;" onclick="toggleDevLog()">Developer log</div>
            <div id="devLogSection" class="hidden" style="margin-top:8px;">
                <pre id="devLogContent" class="dev-log">(Nothing yet — log fills in once you start processing.)</pre>
            </div>

            <div id="resultsCard" class="card hidden" style="margin-top:14px;">
                <h2>Results</h2>
                <div id="resultsContent"></div>
            </div>

            <div class="card" style="margin-top:14px;">
                <div class="link-toggle" onclick="toggleGenreMap()">Genre map (advanced)</div>
                <div id="genreMapSection" class="hidden" style="margin-top:12px;">
                    <div class="genre-map-form">
                        <input type="text" id="genreTag" placeholder="tag, e.g. deep house">
                        <input type="text" id="genreCategory" placeholder="category, e.g. Electronic">
                        <button class="btn" style="flex:0 0 auto;" onclick="addGenreMapping()">Add</button>
                    </div>
                    <div id="genreMapList" class="genre-map-list">
                        <p class="status-text">Loading...</p>
                    </div>
                </div>
            </div>

        </div>

        <script>
            let inputFolder = '';
            let audioOutputFormat = 'same';
            let genreMapLoaded = false;

            function pickFolder(prompt) {
                return fetch('/pick-folder', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt })
                })
                .then(response => response.json().then(data => ({ ok: response.ok, body: data })))
                .then(({ ok, body }) => {
                    if (!ok || body.error) {
                        throw new Error(body.error || 'Folder picker failed');
                    }
                    return body.path;
                });
            }

            function chooseFolder() {
                pickFolder('Select music folder:')
                    .then(path => {
                        if (!path) return;
                        document.getElementById('inputPath').value = path;
                        setInputFolder();
                    })
                    .catch(error => alert(`Could not open folder picker: ${error.message}`));
            }

            function chooseOutputFolder() {
                pickFolder('Select output folder:')
                    .then(path => {
                        if (!path) return;
                        document.getElementById('outputPath').value = path;
                        document.getElementById('outputStatus').innerText = `Selected: ${path}`;
                    })
                    .catch(error => alert(`Could not open folder picker: ${error.message}`));
            }

            function setInputFolder() {
                inputFolder = document.getElementById('inputPath').value.trim();
                if (inputFolder) {
                    document.getElementById('inputStatus').innerText = `Selected: ${inputFolder}`;
                    document.getElementById('fileList').innerText = 'Folder selected. Click "Scan folder" to see files.';
                } else {
                    document.getElementById('inputStatus').innerText = 'Enter a valid path';
                }
            }

            function scanFolder() {
                if (!inputFolder) {
                    alert('Select an input folder first');
                    return;
                }
                document.getElementById('fileList').innerText = 'Scanning...';
                fetch('/scan', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ folder: inputFolder })
                })
                .then(response => response.json().then(data => ({ ok: response.ok, body: data })))
                .then(({ ok, body }) => {
                    if (!ok) {
                        document.getElementById('fileList').innerText = `Error: ${body.error}`;
                        return;
                    }
                    const files = body.files || [];
                    document.getElementById('fileList').innerText = files.length
                        ? `${files.length} music file${files.length === 1 ? '' : 's'} found.`
                        : 'No music files found in this folder.';
                })
                .catch(error => {
                    document.getElementById('fileList').innerText = `Scan failed: ${error.message}`;
                });
            }

            function toggleProcess(id) {
                const row = document.querySelector(`.process-row[data-id="${id}"]`);
                const on = !row.querySelector('.switch').classList.contains('on');
                row.querySelector('.switch').classList.toggle('on', on);
                row.classList.toggle('expanded', on);
            }

            function onLufsModeChange() {
                const mode = document.querySelector('input[name="lufsMode"]:checked').value;
                document.getElementById('customTargetRow').style.display = mode === 'custom' ? 'flex' : 'none';
            }

            function selectAudioFormat(btn) {
                audioOutputFormat = btn.dataset.value;
                btn.parentElement.querySelectorAll('button').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            }

            function setUI(active) {
                document.querySelector('.btn-primary').innerText = active ? 'Processing...' : 'Start processing';
                document.querySelector('.btn-primary').disabled = active;
                document.getElementById('progressWrap').classList.toggle('hidden', !active);
                if (active) {
                    document.getElementById('devLogContent').textContent = '';
                }
            }

            function toggleDevLog() {
                document.getElementById('devLogSection').classList.toggle('hidden');
            }

            function renderDevLog(lines) {
                const el = document.getElementById('devLogContent');
                el.textContent = (lines || []).join('\\n');
                el.scrollTop = el.scrollHeight;
            }

            function renderResults(results) {
                document.getElementById('resultsCard').classList.remove('hidden');
                const content = document.getElementById('resultsContent');
                if (results.length === 0) {
                    content.innerHTML = '<p class="status-text">No files were processed.</p>';
                    return;
                }
                const rows = results.map(r => {
                    if (r.error) {
                        return `<tr><td>${r.original_file.split('/').pop()}</td><td colspan="4" style="color:#e05353;">${r.error}</td></tr>`;
                    }
                    const origName = r.original_file.split('/').pop();
                    const nameCell = r.identified_as
                        ? `<div class="strike">${origName}</div><div>${r.identified_as}</div>`
                        : origName;
                    const gain = r.gain_db != null ? `${r.gain_db > 0 ? '+' : ''}${r.gain_db} dB` : '—';
                    return `<tr>
                        <td>${nameCell}</td>
                        <td>${r.genre ? `<span class="badge">${r.genre}</span>` : '—'}</td>
                        <td>${r.bpm != null ? r.bpm : '—'}</td>
                        <td>${r.key || '—'}</td>
                        <td>${gain}</td>
                    </tr>`;
                }).join('');
                content.innerHTML = `<table class="results">
                    <tr><th>File</th><th>Genre</th><th>BPM</th><th>Key</th><th>Gain</th></tr>
                    ${rows}
                </table>`;
            }

            function pollProcessJob(jobId) {
                fetch(`/process/status/${jobId}`)
                    .then(response => response.json().then(data => ({ ok: response.ok, body: data })))
                    .then(({ ok, body }) => {
                        if (!ok) {
                            setUI(false);
                            alert(body.error || 'Lost track of the processing job');
                            return;
                        }
                        const total = body.total || 0;
                        const done = body.done || 0;
                        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                        document.getElementById('progressFill').style.width = `${pct}%`;
                        document.getElementById('progressLabel').innerText = `${done} / ${total}`;
                        renderDevLog(body.log);

                        if (body.status === 'running') {
                            setTimeout(() => pollProcessJob(jobId), 700);
                            return;
                        }
                        setUI(false);
                        renderResults(body.results || []);
                    })
                    .catch(error => {
                        setUI(false);
                        alert(`Lost track of the processing job: ${error.message}`);
                    });
            }

            function startProcessing() {
                if (!inputFolder) {
                    alert('Select an input folder first');
                    return;
                }

                const steps = {
                    fix_names: document.querySelector('.process-row[data-id="fix_names"] .switch').classList.contains('on'),
                    sort: document.querySelector('.process-row[data-id="sort"] .switch').classList.contains('on'),
                    bpm_key: document.querySelector('.process-row[data-id="bpm_key"] .switch').classList.contains('on'),
                    loudness: document.querySelector('.process-row[data-id="loudness"] .switch').classList.contains('on'),
                };
                if (!Object.values(steps).some(Boolean)) {
                    alert('Turn on at least one process');
                    return;
                }

                const dryRun = document.getElementById('dryRun').checked;
                const maxFilesVal = document.getElementById('maxFiles').value;
                const maxFiles = maxFilesVal ? parseInt(maxFilesVal) : null;

                const lufsModeEl = document.querySelector('input[name="lufsMode"]:checked');
                let mode = 'short_term', targetLufs = -14;
                if (lufsModeEl.value === 'integrated') { mode = 'integrated'; targetLufs = -16; }
                else if (lufsModeEl.value === 'convert_only') { mode = 'convert_only'; targetLufs = null; }
                else if (lufsModeEl.value === 'custom') { mode = 'short_term'; targetLufs = parseFloat(document.getElementById('customTargetSlider').value); }

                setUI(true);
                document.getElementById('progressFill').style.width = '0%';
                document.getElementById('progressLabel').innerText = '0 / 0';
                document.getElementById('resultsCard').classList.add('hidden');

                fetch('/process', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        folder: inputFolder,
                        output_folder: document.getElementById('outputPath').value.trim(),
                        steps: steps,
                        dry_run: dryRun,
                        max_files: maxFiles,
                        mode: mode,
                        target_lufs: targetLufs,
                        safe_limiter: document.getElementById('safeLimiter').checked,
                        remove_silence: document.getElementById('removeSilence').checked,
                        add_prefix: document.getElementById('addPrefix').checked,
                        output_format: audioOutputFormat,
                        sample_rate: document.getElementById('audioSampleRate').value
                    })
                })
                .then(response => response.json().then(data => ({ status: response.status, ok: response.ok, body: data })))
                .then(({ status, ok, body }) => {
                    if (!ok) {
                        setUI(false);
                        alert(body.error || `Request failed (${status})`);
                        return;
                    }
                    pollProcessJob(body.job_id);
                })
                .catch(error => {
                    setUI(false);
                    alert(`Request failed: ${error.message}`);
                });
            }

            function toggleGenreMap() {
                const section = document.getElementById('genreMapSection');
                section.classList.toggle('hidden');
                if (!section.classList.contains('hidden') && !genreMapLoaded) {
                    genreMapLoaded = true;
                    loadGenresMap();
                }
            }

            function loadGenresMap() {
                fetch('/genres')
                    .then(response => response.json())
                    .then(body => renderGenresMap(body.genres || {}))
                    .catch(() => {
                        document.getElementById('genreMapList').innerHTML = '<p class="status-text">Failed to load genre map.</p>';
                    });
            }

            function renderGenresMap(genres) {
                const entries = Object.entries(genres).sort((a, b) => a[0].localeCompare(b[0]));
                const listEl = document.getElementById('genreMapList');
                if (entries.length === 0) {
                    listEl.innerHTML = '<p class="status-text">No mappings yet.</p>';
                    return;
                }
                listEl.innerHTML = entries.map(([tag, category]) => `
                    <div class="genre-map-item">
                        <span>${tag} &rarr; ${category}</span>
                        <button class="del-btn" onclick="deleteGenreMapping('${tag.replace(/'/g, "\\'")}')">&times;</button>
                    </div>
                `).join('');
            }

            function addGenreMapping() {
                const tag = document.getElementById('genreTag').value.trim();
                const category = document.getElementById('genreCategory').value.trim();
                if (!tag || !category) {
                    alert('Enter both a tag and a category');
                    return;
                }
                fetch('/genres', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tag, category })
                })
                .then(response => response.json().then(data => ({ ok: response.ok, body: data })))
                .then(({ ok, body }) => {
                    if (!ok) {
                        alert(body.error || 'Failed to save mapping');
                        return;
                    }
                    document.getElementById('genreTag').value = '';
                    document.getElementById('genreCategory').value = '';
                    renderGenresMap(body.genres || {});
                })
                .catch(error => alert(`Failed to save mapping: ${error.message}`));
            }

            function deleteGenreMapping(tag) {
                fetch(`/genres/${encodeURIComponent(tag)}`, { method: 'DELETE' })
                    .then(response => response.json().then(data => ({ ok: response.ok, body: data })))
                    .then(({ ok, body }) => {
                        if (!ok) {
                            alert(body.error || 'Failed to delete mapping');
                            return;
                        }
                        renderGenresMap(body.genres || {});
                    })
                    .catch(error => alert(`Failed to delete mapping: ${error.message}`));
            }
        </script>
    </body>
    </html>
    ''')


def _clean_path(path: str) -> str:
    """Strip whitespace and matching surrounding quotes (e.g. from Terminal drag-and-drop)."""
    path = (path or '').strip()
    if len(path) >= 2 and path[0] == path[-1] and path[0] in ('"', "'"):
        path = path[1:-1].strip()
    return path


@app.route('/pick-folder', methods=['POST'])
def api_pick_folder():
    """Open a native macOS folder picker and return the chosen absolute path.

    Browsers never expose real filesystem paths from <input type=file>, so this
    shells out to osascript instead. Requires Terminal/Python to have Automation
    permission for Finder/System Events (System Settings -> Privacy & Security).
    """
    if sys.platform != 'darwin':
        return jsonify({'path': None, 'error': 'Native folder picker is only supported on macOS'}), 400

    prompt = (request.json or {}).get('prompt') or 'Select a folder:'
    script = f'''
    tell application "System Events"
        activate
        set theFolder to choose folder with prompt "{prompt}"
        POSIX path of theFolder
    end tell
    '''
    try:
        result = subprocess.run(['osascript', '-e', script], capture_output=True, text=True, timeout=120)
    except Exception as e:
        return jsonify({'path': None, 'error': f'Failed to open folder picker: {e}'}), 500

    if result.returncode != 0:
        stderr = (result.stderr or '').strip()
        if 'User canceled' in stderr:
            return jsonify({'path': None, 'error': None})
        return jsonify({'path': None, 'error': stderr or 'Folder picker failed'}), 500

    return jsonify({'path': result.stdout.strip(), 'error': None})


@app.route('/scan', methods=['POST'])
def api_scan():
    data = request.json or {}
    folder = _clean_path(data.get('folder'))

    if not folder:
        return jsonify({'files': [], 'error': 'Input folder is required'}), 400

    if not os.path.isdir(folder):
        return jsonify({'files': [], 'error': f'Input folder not found: {folder}'}), 400

    # Find music files
    input_path = Path(folder)
    music_files = []
    for ext in SUPPORTED_EXTENSIONS:
        music_files.extend(input_path.glob(f"**/*{ext}"))

    # Return file info
    files_info = []
    for file_path in music_files:
        try:
            stat = file_path.stat()
            files_info.append({
                'name': file_path.name,
                'path': str(file_path),
                'size': stat.st_size,
                'modified': stat.st_mtime
            })
        except Exception as e:
            logger.warning(f"Failed to get info for {file_path}: {e}")

    return jsonify({'files': files_info, 'error': None})


@app.route('/genres', methods=['GET'])
def api_genres_get():
    return jsonify({'genres': load_genres_map()})


@app.route('/genres', methods=['POST'])
def api_genres_set():
    data = request.json or {}
    tag = (data.get('tag') or '').strip().lower()
    category = (data.get('category') or '').strip()

    if not tag or not category:
        return jsonify({'error': 'Both tag and category are required'}), 400

    genres_map = load_genres_map()
    genres_map[tag] = category
    save_genres_map(genres_map)
    return jsonify({'genres': genres_map})


@app.route('/genres/<tag>', methods=['DELETE'])
def api_genres_delete(tag):
    genres_map = load_genres_map()
    genres_map.pop(tag.lower(), None)
    save_genres_map(genres_map)
    return jsonify({'genres': genres_map})


def _append_job_log(job_id: str, line: str):
    stamp = time.strftime('%H:%M:%S')
    with _PROCESS_JOBS_LOCK:
        job = _PROCESS_JOBS.get(job_id)
        if job is not None:
            job['log'].append(f"[{stamp}] {line}")


_LOUDNESS_MODE_LABELS = {
    'short_term': 'Short-Term Max',
    'integrated': 'Integrated',
    'convert_only': 'Convert only',
}


def _describe_result(result: dict) -> list:
    if result.get('error'):
        return [f"  ERROR: {result['error']}"]
    lines = []
    if result.get('identified_as'):
        lines.append(f"  Identified as: {result['identified_as']} (renamed + tagged)")
    lines.append(f"  Genre: {result['genre']}" if result.get('genre') else "  Genre: (sorting off)")

    bpm = result.get('bpm')
    key = result.get('key')
    key_conf = result.get('key_confidence')
    if key and key_conf is not None:
        key_desc = f"{key} (chroma correlation {key_conf:.2f})"
    elif key:
        key_desc = key
    elif key_conf is not None:
        key_desc = f"not confident enough (correlation {key_conf:.2f} < {_KEY_MIN_CONFIDENCE:.2f} threshold)"
    else:
        key_desc = "not detected"
    lines.append(f"  BPM: {bpm if bpm is not None else 'not detected'}   Key: {key_desc}")

    mode = result.get('loudness_mode')
    if mode:
        mode_label = _LOUDNESS_MODE_LABELS.get(mode, mode)
        measured, target, gain, peak = (result.get('measured_lufs'), result.get('target_lufs'),
                                         result.get('gain_db'), result.get('true_peak_before_db'))
        if mode == 'convert_only':
            lines.append("  Loudness: convert only, no gain change applied")
        elif measured is not None and target is not None and gain is not None:
            peak_note = f", true peak before: {peak:+.2f} dBFS" if peak is not None else ""
            lines.append(f"  Loudness ({mode_label}): measured {measured:+.2f} LUFS -> "
                         f"target {target:+.2f} LUFS = gain {gain:+.2f} dB{peak_note}")
        elif gain is not None:
            lines.append(f"  Loudness gain applied: {gain:+.2f} dB")

    lines.append(f"  -> {result['output_file']}")
    return lines


def _run_process_job(job_id: str, files: list, steps: dict, output_folder: str, dry_run: bool,
                      loudness_opts: dict):
    genres_map = load_genres_map()
    results = []
    total = len(files)
    for i, file_path in enumerate(files, start=1):
        name = os.path.basename(str(file_path))
        _append_job_log(job_id, f"[{i}/{total}] Processing: {name}")
        try:
            result = process_track(str(file_path), steps, genres_map, output_folder, dry_run, loudness_opts)
            results.append(result)
            for line in _describe_result(result):
                _append_job_log(job_id, line)
        except Exception as e:
            logger.error(f"Processing failed for {file_path}: {e}")
            results.append({'original_file': str(file_path), 'error': str(e)})
            _append_job_log(job_id, f"  ERROR: {e}")
        with _PROCESS_JOBS_LOCK:
            _PROCESS_JOBS[job_id]['done'] = len(results)
            _PROCESS_JOBS[job_id]['total'] = total

    _append_job_log(job_id, "Done.")
    with _PROCESS_JOBS_LOCK:
        _PROCESS_JOBS[job_id]['status'] = 'done'
        _PROCESS_JOBS[job_id]['results'] = results


@app.route('/process', methods=['POST'])
def api_process():
    data = request.json or {}
    folder = _clean_path(data.get('folder'))
    output_folder = _clean_path(data.get('output_folder')) or SORTED_DIR
    steps = data.get('steps') or {}
    dry_run = bool(data.get('dry_run', False))
    max_files = data.get('max_files')

    if not folder:
        return jsonify({'error': 'Input folder is required'}), 400
    if not os.path.isdir(folder):
        return jsonify({'error': f'Input folder not found: {folder}'}), 400
    if not any(steps.get(k) for k in ('fix_names', 'sort', 'bpm_key', 'loudness')):
        return jsonify({'error': 'Select at least one process to run'}), 400

    loudness_opts = {
        'mode': data.get('mode') or 'short_term',
        'target_lufs': data.get('target_lufs'),
        'safe_limiter': bool(data.get('safe_limiter', False)),
        'remove_silence': bool(data.get('remove_silence', False)),
        'add_prefix': bool(data.get('add_prefix', False)),
        'output_format': data.get('output_format') or 'same',
        'sample_rate': data.get('sample_rate') or 'same',
    }
    if loudness_opts['mode'] == 'short_term':
        loudness_opts['target_lufs'] = float(loudness_opts['target_lufs'] or -14.0)
    elif loudness_opts['mode'] == 'integrated':
        loudness_opts['target_lufs'] = float(loudness_opts['target_lufs'] or -16.0)
    else:
        loudness_opts['target_lufs'] = 0.0

    input_path = Path(folder)
    files = []
    for ext in SUPPORTED_EXTENSIONS:
        files.extend(input_path.glob(f"**/*{ext}"))
    if max_files:
        files = files[:int(max_files)]

    if not files:
        return jsonify({'error': 'No music files found in this folder'}), 400

    job_id = uuid.uuid4().hex
    with _PROCESS_JOBS_LOCK:
        _PROCESS_JOBS[job_id] = {'status': 'running', 'done': 0, 'total': len(files), 'results': None, 'log': []}

    thread = threading.Thread(
        target=_run_process_job,
        args=(job_id, files, steps, output_folder, dry_run, loudness_opts),
        daemon=True
    )
    thread.start()

    return jsonify({'job_id': job_id, 'error': None}), 202


@app.route('/process/status/<job_id>')
def api_process_status(job_id):
    with _PROCESS_JOBS_LOCK:
        job = _PROCESS_JOBS.get(job_id)
        if not job:
            return jsonify({'error': 'Unknown job_id'}), 404
        return jsonify(dict(job))


def main():
    parser = argparse.ArgumentParser(description="Sort music files by genre")
    parser.add_argument('--input', '-i', default=DEFAULT_INPUT_DIR,
                       help=f"Input directory (default: {DEFAULT_INPUT_DIR})")
    parser.add_argument('--output', '-o', default=SORTED_DIR,
                       help=f"Output directory (default: {SORTED_DIR})")
    parser.add_argument('--dry-run', action='store_true',
                       help="Show what would be done without moving files")
    parser.add_argument('--web', action='store_true',
                       help="Start web interface")
    parser.add_argument('--port', '-p', type=int, default=8000,
                       help="Port for web interface (default: 8000)")
    parser.add_argument('--max-files', type=int,
                       help="Maximum number of files to process (for testing)")
    parser.add_argument('--verbose', '-v', action='store_true',
                       help="Enable verbose logging")

    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    if args.web:
        port = args.port
        if not is_port_free(port):
            free_port = find_free_port(start_port=port)
            logger.warning(f"Port {port} is busy, switching to available port {free_port}")
            port = free_port
        logger.info(f"Starting web interface on http://127.0.0.1:{port}")
        if HAS_WAITRESS:
            logger.info("Using Waitress WSGI server for production")
            serve(app, host='0.0.0.0', port=port)
        else:
            logger.warning("Waitress not installed, using Flask dev server")
            app.run(host='0.0.0.0', port=port, use_reloader=False)
    else:
        sort_music(args.input, args.dry_run, args.output, args.max_files)


if __name__ == "__main__":
    main()