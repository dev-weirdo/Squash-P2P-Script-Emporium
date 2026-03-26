"""
Dependencies:
pip install rich av
ffmpeg https://www.ffmpeg.org/download.html
Ensure ffmpeg is in PATH.

@version 2.2
"""
import argparse
import re
import subprocess
import sys
import time
import contextlib

from pathlib import Path

import av
from rich.console import Console

console = Console(color_system="truecolor")

def find_idr_frames(video_file, target_frame, verbose: bool):
    """
    Determines whether the target frame is and IDR frame. If not, find the nearest bi-directional IDR frames.
    video_file: Path to the H.264 video file.
    target_frame: Frame number to check.
    """
    start_time = time.time()
    # run ffmpeg trace_headers
    cmd = ['ffmpeg', '-i', str(video_file), '-c', 'copy', '-bsf:v', 'trace_headers', '-f', 'null', '-']
    
    try:
        process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    except FileNotFoundError as fe:
        console.print(f"[red]{video_file} or ffmpeg not found, ensure ffmpeg is in PATH[/]")
        sys.exit(1)
    except Exception as e:
        console.print(f"[red]Error running ffmpeg:[/] {e}")
        sys.exit(1)
    
    status_ctx = console.status("Starting scan...", spinner="dots") if verbose else contextlib.nullcontext()
    
    idr_frames = set()
    current_frame = -1
    in_slice_header = False
    idr_before = None
    idr_after = None
    target_is_idr = False
    
    # parse h264 bitstream headers
    try:
        with status_ctx as status:
            for line in process.stdout:
                # remove unneeded line content
                match = re.match(r'\[.*?\]\s+(.*)', line)
                if not match:
                    continue
                
                content = match.group(1).strip().lower()
                
                # check for new frame, denoted by access unit delimiter
                if content == "access unit delimiter":
                    current_frame += 1
                    in_slice_header = False
                    
                    if verbose and status is not None:
                        status.update(f"Scanning frame {current_frame}")
                    
                    # if we've found an IDR frame after the target, stop
                    if idr_after is not None:
                        process.terminate()
                        break
                    
                    continue
                
                # check for slice header
                if content == "slice header":
                    in_slice_header = True
                    continue
                
                # check if frame is IDR, denoted by slice header having nal_unit_type = 5
                if in_slice_header and "nal_unit_type" in content:
                    parts = content.split('=')
                    if len(parts) >= 2:
                        nal_type = parts[-1].strip()
                        if nal_type == '5':
                            if current_frame == target_frame:
                                # success, target frame as IDR, stop
                                target_is_idr = True
                                idr_frames.add(current_frame)
                                process.terminate()
                                break
                            elif current_frame < target_frame:
                                idr_before = current_frame
                                idr_frames.add(current_frame)
                            elif current_frame > target_frame and idr_after is None:
                                idr_after = current_frame
                                idr_frames.add(current_frame)
    finally:
        process.wait()
    
    end_time = time.time()
    elapsed_time = end_time - start_time
    console.print(f"\nExecution time: [blue]{elapsed_time:.3f}[/] seconds")
    
    if target_is_idr:
        console.print(f"[green]Frame {target_frame} is an IDR frame[/]")
    else:
        console.print(f"[yellow]Frame {target_frame} is NOT an IDR frame[/]")

    if idr_before is not None:
        console.print(f"Nearest IDR frame before: [green]{idr_before}[/]")
    else:
        console.print("No IDR frame found before the target frame.")
    
    if idr_after is not None:
        console.print(f"Nearest IDR frame after: [green]{idr_after}[/]")
    else:
        console.print("No IDR frame found after the target frame.")
        
    if verbose:
        console.print(f"All IDR frames found: [green]{sorted(idr_frames)}[/]")


def find_safe_frames_mpeg2(video_file, target_frame, verbose: bool):
    """
    Determines whether the target frame is a closed GOP I-frame.
    If not, find the nearest bi-directional closed GOP I-frames.
    video_file: Path to the MPEG-2 video file.
    target_frame: Frame number to check.
    """
    start_time = time.time()
    cmd = ['ffmpeg', '-i', str(video_file), '-c', 'copy', '-bsf:v', 'trace_headers', '-f', 'null', '-']
 
    try:
        process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    except FileNotFoundError:
        console.print(f"[red]{video_file} or ffmpeg not found, ensure ffmpeg is in PATH[/]")
        sys.exit(1)
    except Exception as e:
        console.print(f"[red]Error running ffmpeg:[/] {e}")
        sys.exit(1)
 
    status_ctx = console.status("Starting scan...", spinner="dots") if verbose else contextlib.nullcontext()
 
    safe_cut_frames = set()   # closed GOP I-frames
    all_i_frames = set()      # every I-frame regardless of GOP type
    in_picture_header = False
    in_gop_header = False
    pending_closed_gop = False  # closed_gop flag from the most recent GOP header
    current_temporal_ref = 0    # temporal_reference value of the current picture
    max_temporal_ref = -1       # highest temporal_reference seen in the current GOP
    gop_display_base = 0        # display-order frame number of the first frame in this GOP
    safe_before = None
    safe_after = None
    target_is_safe = False
 
    # NOTE: MPEG-2 frames are stored in decode order but displayed in a different order.
    # B-frames are decoded after the I/P frames they reference, but displayed before them.
    # each picture header carries a temporal_reference field which is the frame's
    # display-order offset within its GOP. The display frame number is:
    #   display_frame = gop_display_base + temporal_reference
 
    try:
        with status_ctx as status:
            for line in process.stdout:
                match = re.match(r'\[.*?\]\s+(.*)', line)
                if not match:
                    continue
 
                content = match.group(1).strip().lower()
 
                # GOP header will tell us if the upcoming I-frame is a closed or open GOP I-frame.
                # advance the display base by the number of frames in the previous GOP
                # (max temporal_reference + 1), then reset for the new GOP.
                if content == "group of pictures header":
                    in_gop_header = True
                    in_picture_header = False
                    gop_display_base += max_temporal_ref + 1
                    max_temporal_ref = -1
                    pending_closed_gop = False  # reset, updated below if field is present
                    continue
 
                if in_gop_header and "closed_gop" in content:
                    parts = content.split('=')
                    if len(parts) >= 2:
                        pending_closed_gop = parts[-1].strip() == '1'
                    in_gop_header = False
                    continue
 
                # new frame, reset temporal ref, check early exit
                if content == "picture header":
                    in_picture_header = True
                    in_gop_header = False
                    current_temporal_ref = 0
 
                    if verbose and status is not None:
                        status.update(f"Scanning around display frame {gop_display_base}")
 
                    if safe_after is not None:
                        process.terminate()
                        break
 
                    continue
 
                # capture the display-order offset of this frame within its GOP
                if in_picture_header and "temporal_reference" in content:
                    parts = content.split('=')
                    if len(parts) >= 2:
                        try:
                            current_temporal_ref = int(parts[-1].strip())
                            if current_temporal_ref > max_temporal_ref:
                                max_temporal_ref = current_temporal_ref
                        except ValueError:
                            pass
                    continue
 
                # frame type, use display_frame for all comparisons
                if in_picture_header and "picture_coding_type" in content:
                    in_picture_header = False
                    parts = content.split('=')
                    if len(parts) >= 2:
                        coding_type = parts[-1].strip()
                        if coding_type == '1':  # I-frame
                            decode_frame = gop_display_base
                            display_frame = gop_display_base + current_temporal_ref
                            all_i_frames.add((decode_frame, display_frame))
                            if pending_closed_gop:
                                if display_frame == target_frame:
                                    target_is_safe = True
                                    safe_cut_frames.add((decode_frame, display_frame))
                                    process.terminate()
                                    break
                                elif display_frame < target_frame:
                                    safe_before = (decode_frame, display_frame)
                                    safe_cut_frames.add((decode_frame, display_frame))
                                elif display_frame > target_frame and safe_after is None:
                                    safe_after = (decode_frame, display_frame)
                                    safe_cut_frames.add((decode_frame, display_frame))
    finally:
        process.wait()
 
    end_time = time.time()
    console.print(f"\nExecution time: [blue]{end_time - start_time:.3f}[/] seconds")
    console.print(f"\nMPEG-2 output frame format: (decoding_order, display_order)")
    # report target frame status
    if target_is_safe:
        console.print(f"[green]Frame {target_frame} is a closed GOP I-frame[/]")
    elif target_frame in all_i_frames:
        console.print(f"[yellow]Frame {target_frame} is an I-frame but is open GOP I-frame[/]")
    else:
        console.print(f"[yellow]Frame {target_frame} is not an I-frame[/]")
 
    # nearest safe cut points
    if safe_before is not None:
        console.print(f"Nearest closed GOP I-frame before: [green]{safe_before}[/]")
    else:
        console.print("[yellow]No closed GOP I-frame found before the target frame[/]")
 
    if safe_after is not None:
        console.print(f"Nearest closed GOP I-frame after: [green]{safe_after}[/]")
    else:
        console.print("[yellow]No closed GOP I-frame found after the target frame.[/]")
 
    if verbose:
        console.print(f"All closed GOP I-frames: [green]{sorted(safe_cut_frames)}[/]")


def main():
    parser = argparse.ArgumentParser(
        description='Check if a frame is an IDR frame in an H.264 stream or a closed GOP I-frame in an MPEG-2 stream.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
            Usage:
            check_idr.py video.h264 --frame 1000
            check_idr.py video.m2v -f 1000 --verbose
        '''
    )
    parser.add_argument('video_file', help='Path to the H.264 video file')
    parser.add_argument('-f', '--frame', type=int, required=True,
                        help='Frame number to check')
    parser.add_argument('-v', '--verbose', action='store_true',
                        help='console.prints a list of all IDR frames from 0 -> --frame')
    
    args = parser.parse_args()
    
    video_file = Path(args.video_file)
    av_file = av.open(Path(video_file))
    stream_type = av_file.format.name
    if stream_type == "h264":
        console.print(f"[green]{video_file.name} detected as raw h264[/]")
    elif stream_type == "mpegvideo":
        console.print(f"[green]{video_file.name} detected as raw mpeg[/]")
    else:
        console.print(f"[yellow]Video file must be a raw h264 or mpeg-2 stream.[/yellow]")
        console.print(f"[yellow]Detected file format:[/yellow] {stream_type}")
        return
        
    try:
        frame = int(args.frame)
    except ValueError as ve:
        console.print(f"[red]Frame number must be an integer[/]\n{ve}")
        sys.exit(1)
    verbose = args.verbose
    
    if frame < 0:
        console.print("[red]Frame number must be non-negative[/]")
        sys.exit(1)
    if stream_type == "h264":
        find_idr_frames(str(video_file), frame, verbose)
    elif stream_type == "mpegvideo":
        find_safe_frames_mpeg2(str(video_file), frame, verbose)

if __name__ == "__main__":
    main()
