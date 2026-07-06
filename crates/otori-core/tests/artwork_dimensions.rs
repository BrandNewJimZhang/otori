//! Jacket quality gate: dimension probing straight from image headers.
//! A low-res jacket on the Stage is worse than none (founding-user
//! decision 2026-07-07: enforce a resolution floor structurally).

use otori_core::artwork::probe_dimensions;

/// 1x1 PNG (IHDR width/height at fixed offsets).
const PNG_1X1: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
    0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
    0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x62, 0x00,
    0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
    0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
];

#[test]
fn png_dimensions_from_ihdr() {
    assert_eq!(probe_dimensions(PNG_1X1), Some((1, 1)));
}

#[test]
fn png_big_dimensions() {
    // Patch IHDR to claim 1200x800: bytes 16..20 width, 20..24 height.
    let mut png = PNG_1X1.to_vec();
    png[16..20].copy_from_slice(&1200u32.to_be_bytes());
    png[20..24].copy_from_slice(&800u32.to_be_bytes());
    assert_eq!(probe_dimensions(&png), Some((1200, 800)));
}

#[test]
fn jpeg_dimensions_from_sof0() {
    // Minimal JPEG: SOI, APP0 stub, SOF0 with height=600 width=900, EOI.
    let mut jpg = vec![0xFF, 0xD8]; // SOI
    jpg.extend_from_slice(&[0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00]); // APP0, len 4
    jpg.extend_from_slice(&[
        0xFF, 0xC0, 0x00, 0x0B, // SOF0, len 11
        0x08, // precision
        0x02, 0x58, // height 600
        0x03, 0x84, // width 900
        0x01, 0x00, 0x00, 0x00, // 1 component stub
    ]);
    jpg.extend_from_slice(&[0xFF, 0xD9]); // EOI
    assert_eq!(probe_dimensions(&jpg), Some((900, 600)));
}

#[test]
fn webp_vp8x_dimensions() {
    // RIFF/WEBP with VP8X extended header: 24-bit minus-one dims.
    let mut webp = Vec::new();
    webp.extend_from_slice(b"RIFF");
    webp.extend_from_slice(&30u32.to_le_bytes());
    webp.extend_from_slice(b"WEBP");
    webp.extend_from_slice(b"VP8X");
    webp.extend_from_slice(&10u32.to_le_bytes());
    webp.extend_from_slice(&[0u8; 4]); // flags + reserved
    webp.extend_from_slice(&799u32.to_le_bytes()[..3]); // width-1 = 799 → 800
    webp.extend_from_slice(&599u32.to_le_bytes()[..3]); // height-1 = 599 → 600
    assert_eq!(probe_dimensions(&webp), Some((800, 600)));
}

#[test]
fn garbage_is_none_not_panic() {
    assert_eq!(probe_dimensions(b"not an image at all"), None);
    assert_eq!(probe_dimensions(&[]), None);
    assert_eq!(probe_dimensions(&[0xFF, 0xD8, 0xFF]), None); // truncated JPEG
}
