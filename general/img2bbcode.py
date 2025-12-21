# Dependencies:
# pip install pyperclip
import sys

import pyperclip

IMG_SIZE = 400     # preferred bbcode img size
IMAGES_PER_ROW = 2 # number of images per row


def process_links(raw_text: str) -> str:
    # split text on any whitespace (newlines, spaces, tabs)
    urls = raw_text.split()

    bb_links = [
        f"[url={url}][img={IMG_SIZE}]{url}[/img][/url]"
        for url in urls
    ]

    # group links to be equal to IMAGES_PER_ROW images on each line
    grouped_lines = []
    for i in range(0, len(bb_links), IMAGES_PER_ROW):
        grouped_lines.append(" ".join(bb_links[i:i + IMAGES_PER_ROW]))

    return "\n".join(grouped_lines)


if __name__ == "__main__":
    text = pyperclip.paste()
    if not text.strip():
        print("Clipboard is empty.")
        sys.exit(1)

    result = process_links(text)
    pyperclip.copy(result)
    print(f"Formatted links:\n{result}")
