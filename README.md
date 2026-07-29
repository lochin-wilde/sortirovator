# Music Genre Sorter

Production-ready script for macOS that automatically sorts music files by genre using metadata, online APIs, and local ML analysis.

## Features

- **Multi-source genre detection**: Metadata → MusicBrainz API → Last.fm API → Librosa ML analysis
- **Supported formats**: MP3, WAV, FLAC, M4A
- **Smart parsing**: Extracts artist/track from filenames
- **Rate limiting**: Respects API limits (1 req/sec)
- **Progress tracking**: tqdm progress bars
- **Web interface**: Easy-to-use browser interface
- **Dry run mode**: Test without moving files
- **Extensible genres**: JSON-based genre mapping

## Installation

1. Install Python dependencies:
```bash
pip install requests mutagen librosa numpy tqdm musicbrainzngs flask
```

2. Get API keys:
   - Last.fm API key: https://www.last.fm/api
   - Update `LASTFM_API_KEY` in the script

## Usage

### Command Line

```bash
# Sort files in default directory
python music_genre_sorter.py

# Sort specific directory
python music_genre_sorter.py --input /path/to/music

# Dry run (no files moved)
python music_genre_sorter.py --dry-run

# Verbose logging
python music_genre_sorter.py --verbose
```

### Web Interface

```bash
python music_genre_sorter.py --web
```

Then open http://127.0.0.1:8000 in your browser.

## Genre Categories

Files are sorted into these folders:
- Hip-Hop
- Electronic
- Rock
- Pop
- Jazz
- Classical
- Unknown

## macOS Permissions

For the folder picker in web interface, allow Terminal/Python to control Finder:
- System Settings → Privacy & Security → Automation
- Enable for Terminal/Finder

## Configuration

Edit `genres_map.json` to customize genre mappings.

## Example Output Structure

```
~/Downloads/SortedMusic/
├── Hip-Hop/
│   ├── artist1 - track1.mp3
│   └── artist2 - track2.mp3
├── Electronic/
│   ├── artist3 - track3.mp3
└── ...
```

## Troubleshooting

- **No internet**: Falls back to metadata/local analysis
- **API errors**: Continues with next detection method
- **Corrupted files**: Skips with warning
- **Permission denied**: Check folder permissions

## License

MIT