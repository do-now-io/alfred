//! Windows system-audio capture via WASAPI loopback (spec/03).
//!
//! Opens the **default render device** in loopback mode and asks WASAPI to
//! auto-convert to 16 kHz mono f32 (AUTOCONVERTPCM + SRC): what the speakers
//! play is captured directly at Whisper's target rate, no resampling on our
//! side. Output: mono PCM16 WAV at 16 kHz.
//!
//! Loopback only produces packets while something is rendering. To keep the
//! recording roughly wall-clock aligned (important for `mixed`), event-wait
//! timeouts are filled with silence.

use anyhow::{anyhow, Result};
use hound::{WavSpec, WavWriter};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// 16 kHz mono: Whisper's native rate, and the common rate used to mix with the mic.
pub const LOOPBACK_SAMPLE_RATE: u32 = 16_000;
const EVENT_TIMEOUT_MS: u32 = 100;

/// Blocking capture loop: runs until `stop_flag` is set, then finalizes the WAV.
pub fn record_system_audio(file_path: PathBuf, stop_flag: Arc<AtomicBool>) -> Result<()> {
    // Per-thread COM init (multithreaded apartment). Failure here is fatal for capture.
    wasapi::initialize_mta()
        .ok()
        .map_err(|e| anyhow!("COM init: {}", e))?;

    let device = wasapi::get_default_device(&wasapi::Direction::Render)
        .map_err(|e| anyhow!("Périphérique de sortie introuvable: {}", e))?;
    let mut client = device
        .get_iaudioclient()
        .map_err(|e| anyhow!("IAudioClient: {}", e))?;

    // f32, 16 kHz, mono — WASAPI converts from the device mix format for us.
    let format = wasapi::WaveFormat::new(
        32,
        32,
        &wasapi::SampleType::Float,
        LOOPBACK_SAMPLE_RATE as usize,
        1,
        None,
    );

    let (default_period, _min_period) = client
        .get_device_period()
        .map_err(|e| anyhow!("get_device_period: {}", e))?;

    client
        .initialize_client(
            &format,
            // Capture direction on a render device = loopback.
            &wasapi::Direction::Capture,
            // autoconvert = AUTOCONVERTPCM | SRC_DEFAULT_QUALITY
            &wasapi::StreamMode::EventsShared {
                autoconvert: true,
                buffer_duration_hns: default_period,
            },
        )
        .map_err(|e| anyhow!("initialize_client (loopback): {}", e))?;

    let event = client
        .set_get_eventhandle()
        .map_err(|e| anyhow!("event handle: {}", e))?;
    let capture = client
        .get_audiocaptureclient()
        .map_err(|e| anyhow!("capture client: {}", e))?;

    let spec = WavSpec {
        channels: 1,
        sample_rate: LOOPBACK_SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer =
        WavWriter::create(&file_path, spec).map_err(|e| anyhow!("WavWriter: {}", e))?;

    client
        .start_stream()
        .map_err(|e| anyhow!("start_stream: {}", e))?;
    eprintln!("[audio/loopback] system capture started ({} Hz mono)", LOOPBACK_SAMPLE_RATE);

    // Raw f32 LE bytes from WASAPI.
    let mut byte_queue: VecDeque<u8> = VecDeque::new();
    let silence_chunk = (LOOPBACK_SAMPLE_RATE as u64 * EVENT_TIMEOUT_MS as u64 / 1000) as usize;

    while !stop_flag.load(Ordering::Relaxed) {
        match event.wait_for_event(EVENT_TIMEOUT_MS) {
            Ok(()) => {
                capture
                    .read_from_device_to_deque(&mut byte_queue)
                    .map(|_info| ())
                    .map_err(|e| anyhow!("read_from_device: {}", e))?;
                while byte_queue.len() >= 4 {
                    let bytes = [
                        byte_queue.pop_front().unwrap(),
                        byte_queue.pop_front().unwrap(),
                        byte_queue.pop_front().unwrap(),
                        byte_queue.pop_front().unwrap(),
                    ];
                    let s = f32::from_le_bytes(bytes);
                    let _ = writer.write_sample((s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
                }
            }
            Err(_) => {
                // Nothing rendered during the window (silence): keep wall-clock
                // alignment by writing the equivalent stretch of silence.
                for _ in 0..silence_chunk {
                    let _ = writer.write_sample(0i16);
                }
            }
        }
    }

    let _ = client.stop_stream();
    writer.finalize().map_err(|e| anyhow!("WAV finalize: {}", e))?;
    eprintln!("[audio/loopback] system capture stopped -> {:?}", file_path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real 2-second loopback capture on the default render device. Verifies
    /// the WASAPI plumbing end-to-end (init, autoconvert, silence fill, WAV).
    #[test]
    fn captures_system_audio_wav() {
        let dir = std::env::temp_dir().join("alfred-loopback-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("loopback.wav");

        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = stop.clone();
        let path_thread = path.clone();
        let handle =
            std::thread::spawn(move || record_system_audio(path_thread, stop_thread));

        std::thread::sleep(std::time::Duration::from_secs(2));
        stop.store(true, Ordering::SeqCst);
        handle.join().unwrap().expect("loopback capture failed");

        let reader = hound::WavReader::open(&path).expect("WAV should open");
        let spec = reader.spec();
        assert_eq!(spec.sample_rate, LOOPBACK_SAMPLE_RATE);
        assert_eq!(spec.channels, 1);
        // ~2 s of samples expected (allow generous slack for startup latency).
        let n = reader.len();
        assert!(n > LOOPBACK_SAMPLE_RATE, "too few samples: {}", n);

        let _ = std::fs::remove_file(&path);
    }
}
