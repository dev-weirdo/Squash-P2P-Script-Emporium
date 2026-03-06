#!/usr/bin/env python3
"""
Download subtitles from Megogo videos.

Dependencies:
    pip install aiohttp beautifulsoup4 lxml rich git+https://github.com/vevv/subby.git

Usage:
    python megogosubdl.py <megogo_url>
"""

import argparse
import asyncio
import json
import re
from pathlib import Path

import aiohttp
from bs4 import BeautifulSoup
from rich.console import Console
from rich.markup import escape
from rich.progress import BarColumn, Progress, SpinnerColumn, TaskProgressColumn, TextColumn
from subby import CommonIssuesFixer, SAMIConverter, SDHStripper, SMPTEConverter, WebVTTConverter

# output directory for downloaded subtitles
OUTPUT_DIR = r"E:\WEB-DL-Subtitles"

NUMBERED_SUFFIX = re.compile(r'^(.*?)-(\d{1,2})(\.[^.]+)?$', re.IGNORECASE)

console = Console(color_system="truecolor")
common_issues_fixer = CommonIssuesFixer()
stripper = SDHStripper()
sami_converter = SAMIConverter()
smpte_converter = SMPTEConverter()
vtt_converter = WebVTTConverter()


# megogo api url
# https://megogo.net/wb/videoEmbed_v3/stream?lang={lang}&obj_id={video_id}&drm_type=modular
class MegogoClient:
    def __init__(self, output_dir: Path):
        self.output_dir = output_dir
        self.connector = aiohttp.TCPConnector(limit=50)
        self.timeout = aiohttp.ClientTimeout(total=60)
        self.session = aiohttp.ClientSession(connector=self.connector, timeout=self.timeout)

    def _extract_video_id(self, url: str) -> str:
        """Extract the numeric video ID from a Megogo URL string."""
        match = re.search(r"/view/(\d+)", url)
        if not match:
            raise ValueError(f"Could not extract video ID from URL: {url}")
        return match.group(1)

    async def _fetch(self, url: str) -> str:
        """Fetch a URL and return the response as text."""
        async with self.session.get(url) as resp:
            try:
                resp.raise_for_status()
                return await resp.text(encoding="utf-8")
            except Exception as e:
                console.print(f"[red][MEGOGO CLIENT][/red] Failed to fetch url: {url}\n{e}")
                return None

    async def _fetch_release_year(self, video_url: str) -> str | None:
        """
        Fetch the video page HTML and extract the release year from the
        <a class="video-year link-default"> element.
        Megogo's API does not provide the release year from what I saw, so we scrape from here instead.

        Returns the year as a string (e.g. "1943"), or None if not found.
        """
        html = await self._fetch(video_url)
        soup = BeautifulSoup(html, "lxml")
        year_tag = soup.find("a", class_="video-year")
        if year_tag:
            return year_tag.get_text(strip=True)
        return None

    async def _download_subtitle(self, subtitle: dict) -> Path:
        filename = subtitle.get("filename")
        content_title = subtitle.get("content_title")
        content_year = subtitle.get("content_year")
        subtitle_text = await self._fetch(subtitle.get("url"))
        if subtitle_text is None:
            return None

        subtitle_text = subtitle_text.replace("\r\n", "\n")
        folder_name = f"{sanitize_filename(content_title, folder=True)} ({content_year})"
        movie_folder = self.output_dir / folder_name / "Megogo"
        movie_folder.mkdir(parents=True, exist_ok=True)
        filepath = movie_folder / filename
        filepath.write_text(subtitle_text, encoding="utf-8")
        return filepath

    async def download_subtitles(self, video_url: str) -> list[Path]:
        video_id = self._extract_video_id(video_url)
        console.print(f"[green][MEGOGO CLIENT][/green] Video ID: [dodger_blue1]{video_id}[/dodger_blue1]")

        api_url = f"https://megogo.net/wb/videoEmbed_v3/stream?lang=en&obj_id={video_id}&drm_type=modular"
        headers = {
            "accept": "*/*",
            "accept-language": "en-US,en;q=0.9",
            "cache-control": "no-cache, no-store, must-revalidate",
            "expires": "0",
            "pragma": "no-cache",
            "referer": video_url,
            "user-agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/145.0.0.0 Safari/537.36"
            ),
            "x-requested-with": "XMLHttpRequest",
        }
        self.session.headers.update(headers)

        # fetch API response to get master playlist
        console.print(f"[green][MEGOGO CLIENT][/green] Fetching metadata for {video_url}")
        try:
            api_text = await self._fetch(api_url)
            api_json = json.loads(api_text)
            year = await self._fetch_release_year(video_url)
        except Exception as e:
            console.print(f"[red]Error fetching API data:[/red] {e}")
            return []

        # extract subtitles and content title from API response
        video_json = api_json["data"]["widgets"]["videoEmbed_v3"]["json"]
        subtitles = video_json.get("subtitles", [])
        if not subtitles:
            console.print("[yellow][MEGOGO CLIENT][/yellow] No subtitles available for download")
            return []
        title = video_json.get("title", video_id)
        console.print(
            f"[green][MEGOGO CLIENT][/green] Title: [sea_green2]{title}[/sea_green2] ([dodger_blue1]{year}[/dodger_blue1])"
        )
        console.print(f"[green][MEGOGO CLIENT][/green] Found [orange1]{len(subtitles)}[/orange1] subtitle(s)")
        
        subs = []
        used_filenames = set()
        for subtitle in subtitles:
            subtitle_language = subtitle.get("lang_iso_639_1")
            if subtitle_language == "en":
                subtitle_language = "en-US"
            subtitle_type = subtitle.get("display_name").lower()
            if any(s in subtitle_type for s in ("forced","auto","авто")):
                subtitle_type = "[forced]"
            elif "sdh" in subtitle_type:
                subtitle_type = "[sdh]"
            else:
                subtitle_type = ""
            subtitle_url = subtitle.get("url")
            filename = f"{sanitize_filename(title)}.{year}.MEGOGO.WEB.{subtitle_language}{subtitle_type}.srt"
            filename = get_unique_filename(filename, used_filenames)
            subs.append({
                "language": subtitle_language,
                "type": subtitle_type,
                "url": subtitle_url,
                "filename": filename,
                "content_title": title,
                "content_year": year
            })
        results = []
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TaskProgressColumn(),
            console=console,
        ) as progress:
            task_id = progress.add_task(
                "[green][MEGOGO CLIENT][/green] Downloading subtitles", total=len(subs)
            )
            subtitle_tasks = [asyncio.create_task(self._download_subtitle(subtitle)) for subtitle in subs]
            for i, finished in enumerate(asyncio.as_completed(subtitle_tasks)):
                try:
                    subtitle = await finished
                except Exception as e:
                    subtitle = e
                results.append(subtitle)
                progress.update(
                    task_id,
                    advance=1,
                    description=f"Downloading subtitles {i + 1}/{len(subtitle_tasks)}",
                )
        successes = 0
        for result in results:
            if isinstance(result, Path):
                successes += 1
        console.print(
            f"[green][MEGOGO CLIENT][/green] Successfully downloaded [orange1]{successes}[/orange1] subtitle(s)"
        )
        return results


def sanitize_filename(name: str, folder: bool = False) -> str:
    if not name:
        return ""
    s = re.sub(r'[\x00-\x1f<>:"/\\|?*\x7f]+', " ", name).strip()
    if not folder:
        s = s.replace(".-.", "-")
        s = re.sub(r"\s+", ".", s)
        s = re.sub(r"\.+", ".", s)
        s = s.strip(".")
    return s or ""


def get_unique_filename(file_path: str | Path, used_filenames: set[str] = None) -> Path:
    """
    Get a unique filename by incrementing numeric suffixes if needed.
    If the filename ends with -N (1-2 digits), it increments N until no conflict.
    """
    file_path = Path(file_path)
    path_str = str(file_path)
    if used_filenames is None:
        used_filenames = set()

    # if the path doesn't exist and is not used, return as is
    if not file_path.exists() and path_str not in used_filenames:
        used_filenames.add(path_str)
        return file_path

    stem = file_path.stem
    m = NUMBERED_SUFFIX.match(stem)

    if m:
        # file already ends in -N, so we start incrementing from N+1
        main_stem = m.group(1)
        i = int(m.group(2)) + 1
    else:
        # file has no numeric suffix, so we start with -1
        main_stem = stem
        i = 1

    while True:
        new_file_path = file_path.parent / f"{main_stem}-{i}{file_path.suffix}"
        new_path_str = str(new_file_path)
        if not new_file_path.exists() and new_path_str not in used_filenames:
            used_filenames.add(new_path_str)
            return new_file_path

        i += 1


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


def fix_common_issues(directory: str | Path):
    """
    Run common issues fixer on all .srt files in the specified directory.
    A single file may be given as an argument instead of a path to a folder.
    """
    if not directory:
        return
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


async def main():
    parser = argparse.ArgumentParser(description="Download subtitles from the given Megogo video URL.")
    parser.add_argument("url", help="Megogo video URL")
    args = parser.parse_args()

    client = MegogoClient(output_dir=Path(OUTPUT_DIR))
    subtitles = await client.download_subtitles(args.url)
    if not subtitles:
        console.print("[yellow][MEGOGO CLIENT][/yellow] No subtitles available for download")
        return
    try:
        with console.status(
            "[green][CLEANUP][/green] Running cleanup tasks",
            spinner="dots",
            spinner_style="white",
            speed=0.9,
        ):
            for subtitle in subtitles:
                if isinstance(subtitle, Path):
                    fix_common_issues(subtitle)
        console.print("[green][CLEANUP][/green] Cleanup complete")
    finally:
        await client.session.close()


if __name__ == "__main__":
    asyncio.run(main())
