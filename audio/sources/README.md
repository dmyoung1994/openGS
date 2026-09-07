# Cup-drop recording

`inbeeld-21878-hq.mp3` is the public high-quality MP3 preview of **golf_putting.wav** by **inbeeld**, licensed **CC0-1.0**.
Source and license: https://freesound.org/people/inbeeld/sounds/21878/
Download: https://cdn.freesound.org/previews/21/21878_119168-hq.mp3
Retrieved 2026-09-06. This is the compressed preview, not the original lossless recording.
Source SHA-256: `494e15088d8beae9fc13111144e5dfaa6e4c9a69012894980706c58952876a58`.

Reproduce the mono 48 kHz runtime asset from the repository root:

```sh
ffmpeg -y -i audio/sources/inbeeld-21878-hq.mp3 -t 1.55 -af 'highpass=f=75,volume=20dB,afade=t=in:d=0.005,afade=t=out:st=1.45:d=0.1' -ar 48000 -ac 1 -c:a libopus -b:a 96k public/assets/audio/cup-drop-1.ogg
```

This removes trailing silence, filters low-frequency rumble and raises the quiet recording without peak clipping. Update the manifest hash after regenerating (Ogg container serial numbers can differ).
