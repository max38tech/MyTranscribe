"""
Command-Line Interface (CLI) for MyTranscribe.
Transcribe audio files directly from the terminal with automatic filler word cleanup.
Usage:
    python cli.py audio.wav
    python cli.py audio.mp3 --model small --verbal-crutches
"""

from __future__ import annotations
import sys
import os
import argparse
from typing import Optional

# Add project root to sys.path
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from backend.transcriber import Transcriber
from backend.cleaner import DisfluencyCleaner


def main():
    parser = argparse.ArgumentParser(description="MyTranscribe: Transcribe speech and clean filler words.")
    parser.add_argument("audio_path", help="Path to input audio file (WAV, MP3, M4A, OGG, etc.)")
    parser.add_argument("--model", default="base", help="faster-whisper model (tiny, base, small, medium, large-v3)")
    parser.add_argument("--language", default=None, help="Language code (e.g. en, es, fr, or None for auto-detect)")
    parser.add_argument("--no-vocal-fillers", action="store_true", help="Do not remove vocal fillers (uh, um, uuhmmm)")
    parser.add_argument("--verbal-crutches", action="store_true", help="Remove verbal crutches (like, you know, sort of)")
    parser.add_argument("--no-repetitions", action="store_true", help="Do not remove stuttered word repetitions")
    parser.add_argument("--custom-fillers", default=None, help="Comma-separated list of custom words to remove")
    parser.add_argument("--custom-preserve", default=None, help="Comma-separated list of words to preserve")
    parser.add_argument("--output", "-o", default=None, help="Path to save cleaned text output")
    parser.add_argument("--raw", action="store_true", help="Also print raw uncleaned transcription")

    args = parser.parse_args()

    if not os.path.exists(args.audio_path):
        print(f"Error: File not found: {args.audio_path}", file=sys.stderr)
        sys.exit(1)

    print(f"[*] Loading model '{args.model}'...")
    transcriber = Transcriber(default_model=args.model)
    transcriber.load_model()

    print(f"[*] Transcribing '{args.audio_path}'...")
    with open(args.audio_path, "rb") as f:
        audio_bytes = f.read()

    audio_np = transcriber.decode_audio_bytes(audio_bytes)
    res = transcriber.transcribe(audio_np, language=args.language)

    custom_fillers = [w.strip() for w in args.custom_fillers.split(",") if w.strip()] if args.custom_fillers else []
    custom_preserve = [w.strip() for w in args.custom_preserve.split(",") if w.strip()] if args.custom_preserve else []

    cleaner = DisfluencyCleaner(
        remove_vocal_fillers=not args.no_vocal_fillers,
        remove_verbal_crutches=args.verbal_crutches,
        remove_repetitions=not args.no_repetitions,
        custom_fillers=custom_fillers,
        custom_preserve=custom_preserve,
    )

    clean_res = cleaner.clean(res["text"])

    print("\n" + "=" * 60)
    if args.raw:
        print("RAW TRANSCRIPTION:")
        print(res["text"])
        print("-" * 60)
    print("CLEANED TRANSCRIPTION:")
    print(clean_res["cleaned_text"])
    print("=" * 60)
    print(f"Stats: {clean_res['removed_count']} filler sounds removed | {res['duration']}s audio | Lang: {res['language']}")

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(clean_res["cleaned_text"])
        print(f"Saved output to: {args.output}")


if __name__ == "__main__":
    main()
