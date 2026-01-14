import argparse
import sys
from pathlib import Path

from subby import CommonIssuesFixer
from subby import SubRipFile
from subby import WebVTTConverter, SAMIConverter, SMPTEConverter, SDHStripper

common_issues_fixer = CommonIssuesFixer()
stripper = SDHStripper()
sami_converter = SAMIConverter()
smpte_converter = SMPTEConverter()
vtt_converter = WebVTTConverter()


def get_subtitle_files(directory: str | Path, *extensions) -> list[Path]:
    """
    Get all subtitle files in the specified directory.
    If no extensions are given (or all given extensions are None/empty),
    defaults to returning a list of files with these extensions: dfxp, sami, srt, ttml, ttml2, vtt.
    Pass any number of extensions, e.g. get_subtitle_files(dir, "srt", ".ass", "VTT").
    Extensions are matched case-insensitively and may include or omit the leading dot.
    """
    path = Path(directory)

    # default subtitle extensions
    default_exts = {"dfxp", "sami", "srt", "ttml", "ttml2", "vtt"}

    # normalize provided extensions (skip None/empty)
    if not extensions or all(e is None or e == "" for e in extensions):
        allowed = default_exts
    else:
        allowed = {str(e).lstrip(".").lower() for e in extensions if e is not None and str(e) != ""}
    subtitle_files = []
    for ext in allowed:
        subtitle_files.extend(path.glob(f"*.{ext}"))
    return subtitle_files


def convert_to_srt(directory: str | Path, persist: bool = False):
    """
    Convert all non-SRT files to SRT format in the given directory.
    If an SRT file with the same name already exists, the file will be skipped.
    """
    directory = Path(directory)
    sami_files = get_subtitle_files(directory, "sami")
    smpte_files = get_subtitle_files(directory, "dfxp", "ttml", "ttml2")
    vtt_files = get_subtitle_files(directory, "vtt")

    def convert(converter, subtitle_files: list[Path], persist: bool = False):
        for file in subtitle_files:
            output_srt = directory / (file.stem + ".srt")
            if output_srt.exists():
                continue

            srt = converter.from_file(file)
            srt.save(output_srt)
            if not persist:
                file.unlink()

    if sami_files: convert(sami_converter, sami_files, persist)
    if smpte_files: convert(smpte_converter, smpte_files, persist)
    if vtt_files: convert(vtt_converter, vtt_files, persist)


def fix_common_issues(directory: str | Path):
    """Run common issues fixer on all .srt files in the specified directory."""
    directory = Path(directory)
    srt_files = get_subtitle_files(directory, "srt")
    for srt_file in srt_files:
        srt, status = common_issues_fixer.from_file(srt_file)
        fixed_srt_file = srt_file.with_name(srt_file.stem + "_fix" + srt_file.suffix)
        srt.save(fixed_srt_file)
        srt_file.unlink()
        fixed_srt_file.rename(srt_file)


def strip_sdh(subtitle_file: str | Path):
    """Strip SDH lines/text with subby on a specific subtitle file."""
    subtitle_file = Path(subtitle_file)
    subtitle_file_stripped = subtitle_file.with_name(subtitle_file.stem + "_stripped" + subtitle_file.suffix)
    srt = SubRipFile.from_string(subtitle_file.read_text(encoding='utf-8'))
    stripped, status = stripper.from_srt(srt)
    if status is True:
        stripped.save(subtitle_file_stripped)
        print(f"Saved stripped file to {subtitle_file_stripped}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Convert all dfxp, sami, ttml, ttml2, and vtt subtitles to srt and run common issue fixer on converted files in the given directory."
    )
    parser.add_argument("directory", nargs="?", type=str, help="Root directory to search for subtitle files.")
    parser.add_argument("--strip-sdh", type=str, help="The path to the subtitle file to strip SDH lines/text from.", required=False)
    
    args = parser.parse_args()
    
    if args.directory:
        root = Path(args.directory)
        if not root.exists():
            print(f"Error: directory '{root}' not found.", file=sys.stderr)
            sys.exit(2)
        convert_to_srt(root)
        root = Path(args.directory)
        fix_common_issues(root)
    if args.strip_sdh:
        strip_sdh_file = Path(args.strip_sdh)
        if not strip_sdh_file.exists():
            print(f"Error: file '{strip_sdh_file}' not found.", file=sys.stderr)
            sys.exit(2)
        strip_sdh(strip_sdh_file)
