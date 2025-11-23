# Video Scripts
<h2><a href="https://github.com/9Oc/Squash-P2P-Script-Emporium/blob/main/video/check_idr.py">check_idr</a>
<a href="https://www.python.org/downloads/release/python-370/"><img src="https://img.shields.io/badge/Python-3.07%2B-brightgreen" alt="Python 3.07+"></a></h2>

`check_idr.py` will determine if a given frame in an h264 raw stream is an IDR frame or not.

Dependencies:

`pip install rich`

[ffmpeg](https://www.ffmpeg.org/download.html) must be installed and in your PATH.
<hr>

### Usage
A path to a raw h264 stream and a frame number are required arguments.

`check_idr.py video.h264 --frame 1000`

Adding the `--verbose` argument will output all IDR frames found up to the given frame number.
<hr>

Example output:
<img src="https://img.onlyimage.org/FtXJGy.png">
