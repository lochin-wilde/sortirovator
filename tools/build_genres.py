#!/usr/bin/env python3
"""Rebuild genres_map.json around the distinctions a DJ actually sorts by.

The old map was built for a general collection: 2932 of its 6700 tags point at
Pop and only 128 at House. For a DJ that is backwards. House is the biggest part
of the library, and collapsing Afro House, Amapiano, Tech House, Deep House,
Bass House and Disco House into one folder turns it into a junk drawer.

The tags themselves are fine -- 'afro house', 'amapiano', 'gqom', 'slap house'
are all already keys in the map. Only the values throw the information away.
So this rewrites values by rule rather than by hand.

Rules are ordered and the first match wins, so the specific ones come first:
'deep tech house' must be read as tech house, not as deep house, and both must
be seen before the bare 'house' rule.
"""
import json
import re
import sys
from collections import Counter

SRC = sys.argv[1]
DST = sys.argv[2]

# Hardcore is two unrelated genres sharing a word. These are the EDM ones; any
# other '<place> hardcore' is hardcore punk and belongs with Rock, which is
# where the old map got it wrong -- 'boston hardcore' was filed under Hardstyle.
EDM_HARDCORE = {
    "hardcore", "hardcore techno", "happy hardcore", "deep happy hardcore",
    "uk hardcore", "gabber", "nu gabber", "frenchcore", "euphoric frenchcore",
    "terrorcore", "speedcore", "splittercore", "extratone", "flashcore",
    "uptempo hardcore", "industrial hardcore", "early hardcore", "mainstream hardcore",
    "freeform hardcore", "digital hardcore", "darkcore", "breakcore",
    "deep breakcore", "chill breakcore", "raggacore", "j-core", "lento violento",
    "mákina", "makina", "hardcore breaks", "breakbeat hardcore", "dark hardcore",
    "deep hardcore",
}

# (regex, genre). Order matters: first match wins.
RULES = [
    # ---- Afro / South African -------------------------------------------------
    (r"\bamapiano\b", "Amapiano"),
    (r"\b(afro ?house|afro ?tech|afrohouse|bolobedu|gqom|kwaito|afro deep|afro melodic)\b", "Afro House"),
    (r"\bsouth african (deep |soulful deep |)house\b", "Afro House"),
    (r"\b(afrobeat|afrobeats|afro pop|afropop|afro fusion|alte)\b", "Afrobeats"),

    # ---- Club / bounce styles -------------------------------------------------
    (r"\b(jersey club|new jersey sound|jersey drill)\b", "Jersey Club"),
    (r"\b(baile funk|brazilian funk|funk carioca|funk brasileiro|favela funk|funk mandel|rasterinha)\b", "Baile Funk"),
    (r"\b(moombahton|moombahcore|moombahsoul)\b", "Moombahton"),
    (r"\b(ghetto ?house|ghettotech|juke|footwork|booty bass|miami bass)\b", "Ghetto House / Juke"),

    # ---- Garage / UK bass -----------------------------------------------------
    (r"\b(uk garage|ukg|2 ?-? ?step|speed garage|bassline|uk funky|future garage|"
     r"garage revival|nu garage|post-garage|liquid garage|organic garage|breakstep|"
     r"old school bassline|uk bass|bass house uk)\b", "UK Garage"),

    # ---- House ----------------------------------------------------------------
    # Tech house before deep house, so 'deep tech house' lands on tech house.
    (r"\btech ?house\b", "Tech House"),
    (r"\bbass house\b", "Bass House"),
    (r"\b(g-house|fidget house|jackin'? house|speed house|hardbass|bouncy house)\b", "Bass House"),
    (r"\b(disco house|funky house|filter house|french house|nu ?-? ?disco|"
     r"jackin|piano house|italo house|diva house|garage house|soulful house|"
     r"deep disco house|deep funk house|saxophone house|electro swing|"
     r"vocal house|deep vocal house|deep soul house|jazz house|lounge house)\b", "Funky / Disco House"),
    (r"\b(slap house|brazilian bass|future house|tropical house|deep tropical house|"
     r"swedish tropical house|vinahouse)\b", "Future / Slap House"),
    (r"\b(melodic house|organic house|balearic|float house|beach house|chill house|"
     r"deep groove house)\b", "Melodic House"),
    (r"\bprogressive (electro |)house\b", "Progressive House"),
    (r"\b(electro house|big room|complextro|dutch house|melbourne bounce|"
     r"future rave|stadium house|scouse house|hardbag|pumping house|"
     r"hard house|uk hard house|chicago hard house)\b", "Electro / Big Room"),
    (r"\b(latin house|latin tech house|house argentino)\b", "Latin House"),
    (r"\bdeep house\b", "Deep House"),
    (r"\b(acid house|chicago house|detroit house|classic house|hip house|"
     r"lo-?fi house|microhouse|minimal tech house|tribal house|"
     r"outsider house|experimental house|ambient house|witch house)\b", "House"),
    (r"\bhouse\b", "House"),

    # ---- Techno ---------------------------------------------------------------
    (r"\b(hard techno|hard minimal techno|hard industrial techno|industrial techno|"
     r"raw techno|destroy techno|deep hardtechno|free tekno|raggatek|jungletek|"
     r"schranz)\b", "Hard Techno"),
    (r"\b(melodic techno|minimal melodic techno|hypnotic techno)\b", "Melodic Techno"),
    (r"\b(minimal|minimal techno|berlin minimal techno|deep minimal techno|"
     r"dark minimal techno|german dark minimal techno|microtechno)\b", "Minimal / Deep Tech"),
    (r"\b(dub techno|ambient dub techno|ambient techno|deep techno)\b", "Minimal / Deep Tech"),
    (r"\b(acid techno|acid|detroit techno|bleep techno|proto-techno|techno)\b", "Techno"),

    # ---- Trance ---------------------------------------------------------------
    (r"\b(psytrance|psychedelic trance|goa trance|goa psytrance|full-on|nitzhonot|"
     r"suomisaundi|dark psytrance|deep psytrance|minimal psytrance|"
     r"progressive psytrance)\b", "Psytrance"),
    (r"\btrance\b", "Trance"),
    (r"\b(hands up|hard dance|hard nrg|jumpstyle)\b", "Hardstyle"),

    # ---- Hard ------------------------------------------------------------------
    (r"\b(hardstyle|rawstyle|euphoric hardstyle|classic hardstyle|gym hardstyle|"
     r"nederlandse hardstyle|dubstyle|trapstyle)\b", "Hardstyle"),

    # ---- Drum & Bass -----------------------------------------------------------
    (r"\b(liquid funk|liquid dnb|liquid drum|atmospheric dnb|atmospheric drum|"
     r"jazzstep|jazzy dnb|intelligent drum|deep dnb|minimal dnb)\b", "Liquid DnB"),
    (r"\b(neurofunk|techstep|darkstep|drumfunk|halftime dnb|drill 'n' bass)\b", "Neurofunk"),
    (r"\b(jungle|ragga jungle|modern jungle)\b", "Jungle"),
    (r"\b(drum ?& ?bass|drum and bass|dnb|jump up|hardstep|dancefloor dnb|"
     r"drumstep|sambass)\b", "Drum & Bass"),

    # ---- Dubstep / bass --------------------------------------------------------
    (r"\b(riddim|riddim dubstep)\b", "Riddim"),
    (r"\b(future bass|kawaii future bass|melodic dubstep)\b", "Future Bass"),
    (r"\b(dubstep|brostep|dubsteppe|funkstep|wonky|glitch hop|midtempo bass|"
     r"bass music)\b", "Dubstep"),
    (r"\b(trap \(edm\)|edm trap|hybrid trap|festival trap)\b", "Trap"),

    # ---- Breaks -----------------------------------------------------------------
    (r"\b(breakbeat|nu skool breaks|florida breaks|big beat|breaks)\b", "Breakbeat"),

    # ---- Urban -------------------------------------------------------------------
    (r"\bphonk\b", "Phonk"),
    (r"\b(boom bap|golden age hip hop|east coast hip hop|jazz rap|"
     r"conscious hip hop|underground hip hop)\b", "Boom Bap"),
    (r"\b(drill|uk drill|brooklyn drill|chicago drill)\b", "Drill"),
    (r"\b(trap|trap soul|cloud rap|mumble rap)\b", "Trap"),
    (r"\b(reggaeton|latin trap|dembow|perreo)\b", "Reggaeton"),
    # Rock guard: 'dub metal', 'ska punk' and friends are rock bands borrowing a
    # rhythm, not reggae. Has to precede the reggae rule, which is deliberately
    # broad because dub itself belongs there.
    (r"\b(dub|ska|reggae)[- ]?(metal|punk|core|rock)\b", "Rock"),
    (r"\b(dancehall|ragga|reggae|dub|rocksteady|ska)\b", "Reggae / Dancehall"),
    (r"\b(hip[ -]?hop|rap|grime)\b", "Hip-Hop"),

    # ---- Disco ---------------------------------------------------------------------
    (r"\b(disco|italo disco|space disco|cosmic disco|hi-nrg|boogie)\b", "Disco"),
]

COMPILED = [(re.compile(p), g) for p, g in RULES]


def classify(tag, old):
    """New genre for a tag, or None to keep whatever the old map said."""
    t = tag.lower().strip()

    # 'hardcore hip hop' is Wu-Tang, not Sick Of It All. Rap tags are settled by
    # the ordinary rules and must not reach the hardcore branch below.
    is_rap = re.search(r"\b(hip[ -]?hop|rap)\b", t)

    # Hardcore first: the word alone does not say which genre it is.
    if not is_rap and ("hardcore" in t or t in ("gabber", "nu gabber", "breakcore", "extratone",
                                "speedcore", "splittercore", "terrorcore",
                                "frenchcore", "euphoric frenchcore", "flashcore",
                                "darkcore", "raggacore", "j-core", "mákina",
                                "lento violento")):
        return "Hardcore" if t in EDM_HARDCORE else "Rock"

    for rx, genre in COMPILED:
        if rx.search(t):
            return genre
    return None


def main():
    old = json.load(open(SRC))
    new = {}
    changed = 0
    for tag, genre in old.items():
        g = classify(tag, genre)
        if g is None:
            new[tag] = genre
        else:
            new[tag] = g
            if g != genre:
                changed += 1

    # Tags the lookups return that the old map never had.
    additions = {
        "baile funk": "Baile Funk", "brazilian funk": "Baile Funk",
        "funk carioca": "Baile Funk", "funk brasileiro": "Baile Funk",
        "liquid drum and bass": "Liquid DnB", "liquid dnb": "Liquid DnB",
        "psytrance": "Psytrance", "indie dance": "Indie Dance",
        "nu disco": "Funky / Disco House", "afro tech": "Afro House",
        "jersey club": "Jersey Club", "amapiano": "Amapiano",
        "afro house": "Afro House", "3-step": "Afro House",
        "melodic house & techno": "Melodic House",
        "afro pop": "Afrobeats", "amapiano house": "Amapiano",
        "uk drill": "Drill", "drill": "Drill", "phonk": "Phonk",
        "hard techno": "Hard Techno", "melodic techno": "Melodic Techno",
        "future bass": "Future Bass", "riddim": "Riddim",
        "breaks": "Breakbeat", "breakbeat": "Breakbeat",
        "big room": "Electro / Big Room", "big room house": "Electro / Big Room",
        "slap house": "Future / Slap House", "brazilian bass": "Future / Slap House",
        "afro soul": "Afrobeats", "gqom": "Afro House",
        "organic house": "Melodic House", "deep tech": "Minimal / Deep Tech",
    }
    added = 0
    for tag, genre in additions.items():
        if tag not in new:
            added += 1
        new[tag] = genre

    json.dump(new, open(DST, "w"), ensure_ascii=False, indent=0, sort_keys=True)

    before = Counter(old.values())
    after = Counter(new.values())
    print(f"  тегов: {len(old)} -> {len(new)}  (добавлено {added})")
    print(f"  переназначено: {changed}")
    print(f"  жанров: {len(before)} -> {len(after)}\n")
    print(f"  {'жанр':<26} {'было':>6} {'стало':>6}")
    print("  " + "-" * 40)
    for g in sorted(after, key=lambda x: -after[x]):
        print(f"  {g:<26} {before.get(g, 0):>6} {after[g]:>6}")


if __name__ == "__main__":
    main()
