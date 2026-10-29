#!/usr/bin/env python3
"""Independent FFmpeg/ffprobe checks for the packaged Windows production-export fixture."""
import argparse
import json
import math
import statistics
import struct
import subprocess
import sys
from pathlib import Path


def run_json(executable, arguments):
    result = subprocess.run([executable, *arguments], check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


def sample_rgb(frame, width, x, y):
    offset = (y * width + x) * 3
    return tuple(frame[offset:offset + 3])


def classify_frame(frame, width, height):
    red, green, blue = sample_rgb(frame, width, 18, 90)
    source_id = None
    if blue > 150 and red < 120 and green < 175:
        source_id = "A"
    elif red > 170 and 65 < green < 165 and blue < 130:
        source_id = "B"
    if source_id is None:
        background = sample_rgb(frame, width, 306, 164)
        if max(background) < 20:
            return {"sourceId": None, "frameIndex": None, "isGap": True, "hasSyncFlash": False}
    frame_index = 0
    for bit in range(6):
        pixel = sample_rgb(frame, width, 72 + bit * 36, 88)
        if max(pixel) > 150:
            frame_index |= 1 << bit
    flash = sample_rgb(frame, width, 294, 28)
    return {
        "sourceId": source_id,
        "frameIndex": frame_index if source_id else None,
        "isGap": False,
        "hasSyncFlash": min(flash) > 190,
    }


def expected_frames(fixture, source_frame_times):
    """Resolve the literal fixture placements against independently probed source PTS."""
    result = []
    placements = fixture["expectedPlacements"]
    pulse_frames = {"A": {6, 15, 22}, "B": {4, 13}}
    fps = float(fixture["frameRate"]["numerator"]) / float(fixture["frameRate"]["denominator"])
    for index in range(fixture["expectedFrameCount"]):
        placement = next((entry for entry in placements if entry["startFrame"] <= index < entry["endFrame"]), None)
        if placement is None:
            result.append({"sourceId": None, "frameIndex": None, "isGap": True, "hasSyncFlash": False})
        else:
            requested_source_time = placement["sourceFrameStart"] / fps + (index - placement["startFrame"]) / fps
            decoded_source_index = None
            for source_index, source_time in enumerate(source_frame_times[placement["sourceId"]]):
                if source_time > requested_source_time + 1e-6:
                    break
                decoded_source_index = source_index
            result.append({
                "sourceId": placement["sourceId"] if decoded_source_index is not None else None,
                "frameIndex": decoded_source_index,
                "isGap": decoded_source_index is None,
                "hasSyncFlash": decoded_source_index in pulse_frames[placement["sourceId"]] if decoded_source_index is not None else False,
            })
    return result


def detect_audio_onsets(pcm, sample_rate):
    threshold = int(0.18 * 32768)
    max_gap_samples = round(0.025 * sample_rate)
    samples = (value[0] for value in struct.iter_unpack("<h", pcm[:len(pcm) // 2 * 2]))
    onsets = []
    last_active = -10**12
    for index, sample in enumerate(samples):
        if abs(sample) <= threshold:
            continue
        if index - last_active > max_gap_samples:
            onsets.append(index / sample_rate)
        last_active = index
    return onsets


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-dir", required=True)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument("--smoke-report", required=True)
    parser.add_argument("--report", required=True)
    args = parser.parse_args()
    root = Path(args.artifact_dir)
    output_path = root / "timeline-export.webm"
    fixture = json.loads((root / "fixture.json").read_text(encoding="utf-8"))
    smoke = json.loads(Path(args.smoke_report).read_text(encoding="utf-8"))
    expected_count = int(fixture["expectedFrameCount"])
    expected_duration = float(fixture["expectedDurationSeconds"])
    rate = fixture["frameRate"]
    fps = float(rate["numerator"]) / float(rate["denominator"])
    frame_period = 1.0 / fps
    opus_duration = float(fixture["timingPolicy"]["opusPacketDurationSeconds"])
    source_checks = {}
    source_frame_times = {}
    for source_id in ("A", "B"):
        source_path = root / f"source-{source_id}.webm"
        source_meta = run_json(args.ffprobe, ["-v", "error", "-show_streams", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=codec_name,nb_read_frames", "-of", "json", str(source_path)])
        source_streams = source_meta.get("streams", [])
        if not source_streams or int(source_streams[0].get("nb_read_frames", 0)) != 30:
            raise AssertionError(f"Independent ffprobe source {source_id} check did not find 30 frames")
        source_frames = run_json(args.ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_frames", "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", str(source_path)]).get("frames", [])
        times = [float(frame["best_effort_timestamp_time"]) for frame in source_frames if "best_effort_timestamp_time" in frame]
        if len(times) != 30 or any(right <= left for left, right in zip(times, times[1:])):
            raise AssertionError(f"Independent ffprobe source {source_id} PTS are missing or non-monotonic")
        source_frame_times[source_id] = times
        source_audio = run_json(args.ffprobe, ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name,sample_rate", "-of", "json", str(source_path)]).get("streams", [])
        if not source_audio or source_audio[0].get("codec_name") != "opus" or int(source_audio[0].get("sample_rate", 0)) != 48_000:
            raise AssertionError(f"Independent ffprobe source {source_id} check found no 48 kHz Opus audio")
        subprocess.run([args.ffmpeg, "-v", "error", "-xerror", "-i", str(source_path), "-map", "0:v:0", "-f", "null", "-"], check=True, capture_output=True)
        subprocess.run([args.ffmpeg, "-v", "error", "-xerror", "-i", str(source_path), "-map", "0:a:0", "-f", "null", "-"], check=True, capture_output=True)
        source_checks[source_id] = {"ffprobeVideoFrames": 30, "videoCodec": source_streams[0].get("codec_name"), "audioCodec": source_audio[0].get("codec_name"), "sampleRate": 48_000, "fullDecode": "passed"}

    metadata = run_json(args.ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", str(output_path)])
    streams = metadata.get("streams", [])
    video_stream = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    audio_stream = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
    if video_stream is None:
        raise AssertionError("ffprobe found no output video track")
    if audio_stream is None:
        raise AssertionError("ffprobe found no required output audio track")
    if not str(video_stream.get("codec_name", "")).startswith("vp9"):
        raise AssertionError(f"Expected VP9 output, got {video_stream.get('codec_name')}")
    if audio_stream.get("codec_name") != "opus":
        raise AssertionError(f"Expected Opus output, got {audio_stream.get('codec_name')}")

    def stream_timebase(stream, name):
        value = stream.get("time_base")
        if not value or "/" not in value:
            raise AssertionError(f"ffprobe did not report a {name} track time_base")
        numerator, denominator = (float(part) for part in value.split("/", 1))
        if denominator == 0 or numerator <= 0:
            raise AssertionError(f"ffprobe reported invalid {name} time_base {value}")
        return numerator / denominator

    video_timebase = stream_timebase(video_stream, "video")
    audio_timebase = stream_timebase(audio_stream, "audio")
    sample_rate = int(audio_stream.get("sample_rate", 0))
    if sample_rate <= 0:
        raise AssertionError("ffprobe did not report the output audio sample rate")
    video_tolerance = frame_period / 2 + video_timebase / 2
    audio_onset_tolerance = opus_duration / 2 + audio_timebase / 2 + 1.0 / sample_rate
    audio_duration_tolerance = opus_duration + audio_timebase / 2 + 1.0 / sample_rate
    container_tolerance = max(video_tolerance, audio_duration_tolerance)

    frames_json = run_json(args.ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_frames", "-show_entries", "frame=best_effort_timestamp_time,pkt_duration_time", "-of", "json", str(output_path)])
    frame_records = frames_json.get("frames", [])
    frame_times = [float(frame["best_effort_timestamp_time"]) for frame in frame_records if "best_effort_timestamp_time" in frame]
    if len(frame_records) != expected_count or len(frame_times) != expected_count:
        raise AssertionError(f"ffprobe decoded frame metadata count {len(frame_records)}; expected {expected_count}")
    if any(not math.isfinite(value) for value in frame_times) or any(right <= left for left, right in zip(frame_times, frame_times[1:])):
        raise AssertionError("ffprobe found non-finite or non-monotonic video timestamps")
    expected_times = [index / fps for index in range(expected_count)]
    timestamp_errors = [actual - expected for actual, expected in zip(frame_times, expected_times)]
    if any(abs(error) > video_tolerance for error in timestamp_errors):
        bad = next(index for index, error in enumerate(timestamp_errors) if abs(error) > video_tolerance)
        raise AssertionError(f"video frame {bad} PTS error {timestamp_errors[bad]:.9f}s exceeds {video_tolerance:.9f}s")

    width, height = int(fixture["width"]), int(fixture["height"])
    video_decode = subprocess.run([
        args.ffmpeg, "-v", "warning", "-xerror", "-i", str(output_path), "-map", "0:v:0", "-fps_mode", "passthrough",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ], check=False, capture_output=True)
    if video_decode.returncode != 0:
        stderr = video_decode.stderr.decode("utf-8", errors="replace")[-6000:]
        raise RuntimeError(f"FFmpeg full video decode failed with exit code {video_decode.returncode}: {stderr}")
    decoded = video_decode.stdout
    bytes_per_frame = width * height * 3
    decoded_frame_count, remainder = divmod(len(decoded), bytes_per_frame)
    if remainder or decoded_frame_count != expected_count:
        raise AssertionError(f"FFmpeg full decode produced {decoded_frame_count} frames with {remainder} trailing bytes; expected {expected_count}")
    actual_frames = [classify_frame(decoded[index * bytes_per_frame:(index + 1) * bytes_per_frame], width, height) for index in range(expected_count)]
    expected = expected_frames(fixture, source_frame_times)
    mismatches = [
        {"frameIndex": index, "timestampSeconds": frame_times[index], "expected": expected[index], "actual": actual_frames[index]}
        for index in range(expected_count) if expected[index] != actual_frames[index]
    ]
    if mismatches:
        raise AssertionError(f"Independent decoded content mismatch at output frame {mismatches[0]['frameIndex']}: {mismatches[0]}")

    audio_packets_json = run_json(args.ffprobe, ["-v", "error", "-select_streams", "a:0", "-show_packets", "-show_entries", "packet=pts_time,dts_time,duration_time", "-of", "json", str(output_path)])
    audio_packets = audio_packets_json.get("packets", [])
    audio_packet_times = [float(packet["pts_time"]) for packet in audio_packets if "pts_time" in packet]
    if not audio_packets or len(audio_packet_times) != len(audio_packets):
        raise AssertionError("ffprobe found no timestamped audio packets")
    if any(right <= left for left, right in zip(audio_packet_times, audio_packet_times[1:])):
        raise AssertionError("ffprobe found duplicate or non-monotonic audio packet timestamps")
    audio_packet_durations = [float(packet["duration_time"]) for packet in audio_packets if packet.get("duration_time") not in (None, "N/A", "nan")]
    packet_time_tolerance = audio_timebase + 1.0 / sample_rate
    if not audio_packet_durations or any(duration <= 0 or not math.isfinite(duration) for duration in audio_packet_durations):
        raise AssertionError("ffprobe found missing or invalid audio packet durations")
    if any(abs(duration - opus_duration) > packet_time_tolerance for duration in audio_packet_durations):
        raise AssertionError("ffprobe found an Opus packet duration outside 20 ms plus one measured timebase tick/sample")
    audio_packet_spacing_errors = [
        (right - left) - opus_duration for left, right in zip(audio_packet_times, audio_packet_times[1:])
    ]
    if any(abs(error) > packet_time_tolerance for error in audio_packet_spacing_errors):
        bad = next(error for error in audio_packet_spacing_errors if abs(error) > packet_time_tolerance)
        raise AssertionError(f"audio packet PTS spacing error {bad:.9f}s exceeds {packet_time_tolerance:.9f}s")
    if sample_rate != 48_000:
        raise AssertionError(f"Expected 48 kHz output audio, got {sample_rate} Hz")
    pcm = subprocess.run([
        args.ffmpeg, "-v", "error", "-xerror", "-i", str(output_path), "-map", "0:a:0", "-ac", "1", "-ar", str(sample_rate),
        "-f", "s16le", "pipe:1",
    ], check=True, capture_output=True).stdout
    if not pcm:
        raise AssertionError("FFmpeg decoded no audio samples")
    audio_duration = (len(pcm) // 2) / sample_rate
    audio_onsets = detect_audio_onsets(pcm, sample_rate)
    expected_onsets = [float(value) for value in fixture["expectedAudioPulseOnsetsSeconds"]]
    if len(audio_onsets) != len(expected_onsets):
        raise AssertionError(f"Decoded audio contains {len(audio_onsets)} signal onsets; expected {len(expected_onsets)}: {audio_onsets}")
    audio_onset_errors = [actual - expected for actual, expected in zip(audio_onsets, expected_onsets)]
    if any(abs(error) > audio_onset_tolerance for error in audio_onset_errors):
        bad = next(index for index, error in enumerate(audio_onset_errors) if abs(error) > audio_onset_tolerance)
        raise AssertionError(f"audio onset {bad} error {audio_onset_errors[bad]:.9f}s exceeds {audio_onset_tolerance:.9f}s")

    flash_indexes = [index for index, frame in enumerate(actual_frames) if frame["hasSyncFlash"]]
    expected_flash_indexes = [index for index, frame in enumerate(expected) if frame["hasSyncFlash"]]
    if flash_indexes != expected_flash_indexes:
        raise AssertionError(f"decoded video sync flashes at {flash_indexes}; expected {expected_flash_indexes}")
    pulse_frame_indexes = [int(value) for value in fixture["expectedAudioPulseFrameIndexes"]]
    if len(pulse_frame_indexes) != len(audio_onsets):
        raise AssertionError("fixture audio pulse frame count does not match decoded onset count")
    av_sync = []
    for index, (frame_index, audio_onset) in enumerate(zip(pulse_frame_indexes, audio_onsets)):
        if not actual_frames[frame_index]["hasSyncFlash"]:
            raise AssertionError(f"expected A/V flash marker is absent at pulse onset frame {frame_index}")
        video_time = frame_times[frame_index]
        offset = audio_onset - video_time
        av_sync.append({"event": index, "videoFrame": frame_index, "videoTimestampSeconds": video_time, "audioOnsetSeconds": audio_onset, "audioMinusVideoSeconds": offset})
        if abs(offset) > audio_onset_tolerance:
            raise AssertionError(f"A/V event {index} offset {offset:.9f}s exceeds {audio_onset_tolerance:.9f}s")

    last_duration = frame_records[-1].get("pkt_duration_time")
    if last_duration in (None, "N/A", "nan"):
        last_duration = statistics.median(right - left for left, right in zip(frame_times, frame_times[1:]))
    video_duration = frame_times[-1] + float(last_duration) - frame_times[0]
    container_duration = float(metadata.get("format", {}).get("duration", "nan"))
    duration_deltas = {
        "video": video_duration - expected_duration,
        "audio": audio_duration - expected_duration,
        "container": container_duration - expected_duration,
    }
    if abs(duration_deltas["video"]) > video_tolerance:
        raise AssertionError(f"video duration delta {duration_deltas['video']:.9f}s exceeds {video_tolerance:.9f}s")
    if abs(duration_deltas["audio"]) > audio_duration_tolerance:
        raise AssertionError(f"decoded audio duration delta {duration_deltas['audio']:.9f}s exceeds {audio_duration_tolerance:.9f}s")
    if abs(duration_deltas["container"]) > container_tolerance:
        raise AssertionError(f"container duration delta {duration_deltas['container']:.9f}s exceeds {container_tolerance:.9f}s")

    timeline_report = smoke.get("frameIdentity", {})
    encoder = timeline_report.get("actual", {}).get("encoderConfiguration", {})
    video_encoder = encoder.get("video")
    audio_encoder = encoder.get("audio")
    if not video_encoder or not audio_encoder:
        raise AssertionError("packaged smoke did not report both actual WebCodecs encoder configurations")
    report = {
        "pass": True,
        "validator": "FFmpeg/ffprobe independent process; CI-only, not shipped",
        "outputFile": output_path.name,
        "syntheticSources": source_checks,
        "codec": {"video": video_stream.get("codec_name"), "audio": audio_stream.get("codec_name")},
        "counts": {"ffprobeFrames": len(frame_records), "fullDecodedVideoFrames": decoded_frame_count, "audioPackets": len(audio_packets)},
        "timing": {
            "expectedDurationSeconds": expected_duration,
            "videoDurationSeconds": video_duration,
            "audioDecodedDurationSeconds": audio_duration,
            "containerDurationSeconds": container_duration,
            "durationDeltasSeconds": duration_deltas,
            "videoTimebaseSeconds": video_timebase,
            "audioTimebaseSeconds": audio_timebase,
            "videoTimestampToleranceSeconds": video_tolerance,
            "audioDurationToleranceSeconds": audio_duration_tolerance,
            "containerDurationToleranceSeconds": container_tolerance,
            "audioOnsetToleranceSeconds": audio_onset_tolerance,
            "videoTimestampErrorRangeSeconds": [min(timestamp_errors), max(timestamp_errors)],
            "audioOnsetErrorsSeconds": audio_onset_errors,
            "audioPacketSpacingErrorsSeconds": audio_packet_spacing_errors,
            "audioPacketSpacingToleranceSeconds": packet_time_tolerance,
            "avSyncEvents": av_sync,
        },
        "content": {"identityFramesCompared": expected_count, "mismatchCount": len(mismatches), "firstMismatch": None, "syncFlashIndexes": flash_indexes},
        "encoder": {
            "videoCodec": video_stream.get("codec_name"),
            "audioCodec": audio_stream.get("codec_name"),
            "videoWebCodecsConfiguration": video_encoder,
            "audioWebCodecsConfiguration": audio_encoder,
            "hardwareAccelerationFieldIsPreferenceNotProof": True,
            "physicalHardwareEncoderVerified": False,
        },
    }
    Path(args.report).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # keep a useful failed report/artifact in CI logs
        print(f"independent export validation failed: {error}", file=sys.stderr)
        if "--report" in sys.argv:
            try:
                report_path = Path(sys.argv[sys.argv.index("--report") + 1])
                report_path.write_text(json.dumps({"pass": False, "validator": "FFmpeg/ffprobe independent process; CI-only, not shipped", "error": str(error)}, indent=2) + "\n", encoding="utf-8")
            except Exception:
                pass
        raise
