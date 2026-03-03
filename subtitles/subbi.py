import argparse
import re
import sys
from pathlib import Path

from subby import CommonIssuesFixer
from subby import SubRipFile
from subby import WebVTTConverter, SAMIConverter, SMPTEConverter, SDHStripper

REGIONAL_TAG_MAP = {
    "en-001": "en-US", "en-150": "en-US",
    "ar-100": "ar", "ar-SA": "ar",
    "bg-BG": "bg",
    "ca-ES": "ca",
    "cs-CZ": "cs",
    "da-DK": "da",
    "de-DE": "de",
    "el-GR": "el",
    "et-EE": "et", "et-ET": "et",
    "eu-ES": "eu",
    "fi-FI": "fi",
    "fil-PH": "fil",
    "gl-ES": "gl",
    "he-IL": "he",
    "hi-IN": "hi",
    "hr-HR": "hr",
    "hu-HU": "hu",
    "id-ID": "id",
    "is-IS": "is",
    "it-IT": "it",
    "ja-JP": "ja",
    "kn-IN": "kn",
    "ko-KR": "ko",
    "lt-LT": "lt",
    "lv-LV": "lv",
    "mk-MK": "mk",
    "ml-IN": "ml",
    "mr-IN": "mr",
    "ms-MY": "ms",
    "nb-NO": "nb", "no-NO": "no", "nn-NO": "nn",
    "nl-NL": "nl",
    "pl-PL": "pl",
    "ro-RO": "ro",
    "ru-RU": "ru",
    "sk-SK": "sk",
    "sl-SI": "sl", "sl-SL": "sl",
    "sk-SK": "sk",
    "sr-Latn": "sr", "sr-RS": "sr",
    "sv-SE": "sv", "sv-SV": "sv",
    "ta-IN": "ta",
    "te-IN": "te",
    "th-TH": "th",
    "tr-TR": "tr",
    "uk-UA": "uk",
    "vi-VN": "vn",
}
REGIONAL_TAG_PATTERN = re.compile("|".join(re.escape(k) for k in REGIONAL_TAG_MAP))

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


def remove_sdh_tags(text: str) -> str:
    return re.sub(r"(?i)(?:\[sdh\]|\bsdh\b|\.sdh\b)", "", text)


def convert_to_srt(directory: str | Path, persist: bool = False) -> list[Path]:
    """
    Convert all non-SRT files to SRT format in the given directory.
    If an SRT file with the same name already exists, the file will be skipped.
    Returns the list of converted files as Path objects.
    """
    directory = Path(directory)
    jobs = [
        (sami_converter, get_subtitle_files(directory, "sami")),
        (smpte_converter, get_subtitle_files(directory, "dfxp", "ttml", "ttml2")),
        (vtt_converter, get_subtitle_files(directory, "vtt")),
    ]
    converted_files: list[Path] = []
    for converter, subtitle_files in jobs:
        if not subtitle_files:
            continue
        for subtitle_file in subtitle_files:
            output_srt = directory / (subtitle_file.stem + ".srt")
            if output_srt.exists():
                continue
            srt = converter.from_file(subtitle_file)
            srt.save(output_srt)
            if not persist:
                subtitle_file.unlink()
            converted_files.append(output_srt)
    return converted_files


def fix_common_issues(directory: str | Path):
    """
    Run common issues fixer on all .srt files in the specified directory.
    A single file may be given as an argument instead of a directory.
    """
    directory = Path(directory)
    if directory.is_file():
        srt_files = [directory]
    else:
        srt_files = get_subtitle_files(directory, "srt")
    for srt_file in srt_files:
        srt, status = common_issues_fixer.from_file(srt_file)
        fixed_srt_file = srt_file.with_name(srt_file.stem + "_fix" + srt_file.suffix)
        srt.save(fixed_srt_file)
        srt_file.unlink()
        fixed_srt_file.rename(srt_file)


def fix_region(directory: str | Path):
    """
    Strip un-needed regional tags from any subtitle file-names in the specified directory.
    A single file may be given as an argument instead of a directory.
    """
    directory = Path(directory)
    if directory.is_file():
        srt_files = [directory]
    else:
        srt_files = get_subtitle_files(directory)
    for srt_file in srt_files:
        file_name = srt_file.stem
        match = REGIONAL_TAG_PATTERN.search(file_name)
        if not match:
            continue

        key = match.group(0)
        stripped_file_name = file_name.replace(key, REGIONAL_TAG_MAP[key])
        stripped_file_path = srt_file.with_name(stripped_file_name + srt_file.suffix)
        if stripped_file_path.exists():
            continue
        srt_file.rename(stripped_file_path)

def strip_sdh(subtitle_file: str | Path) -> Path:
    """
    Strip SDH lines/text with subby on a specific subtitle file.
    Common issue fixer is ran on the stripped file afterward.
    """
    subtitle_file = Path(subtitle_file)
    subtitle_file_name = subtitle_file.stem
    stripped_file_name = remove_sdh_tags(subtitle_file_name)
    if str(subtitle_file_name) == str(stripped_file_name):
        stripped_file_name += "_stripped"
    subtitle_file_stripped = subtitle_file.with_name(stripped_file_name + subtitle_file.suffix)
    srt = SubRipFile.from_string(subtitle_file.read_text(encoding='utf-8'))
    stripped, status = stripper.from_srt(srt)
    if status is True:
        stripped.save(subtitle_file_stripped)
        fix_common_issues(subtitle_file_stripped)
        return subtitle_file_stripped
    return subtitle_file


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
        fix_region(root)
    if args.strip_sdh:
        strip_sdh_file = Path(args.strip_sdh)
        if not strip_sdh_file.exists():
            print(f"Error: file '{strip_sdh_file}' not found.", file=sys.stderr)
            sys.exit(2)
        strip_sdh(strip_sdh_file)
