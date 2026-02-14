/**
 * @version 1.3.5
 * Limits.js - Safety thresholds for memory and resource allocation
 */

module.exports = {
    MaxImageDimension: 4096,
    MaxPackBitsDecompressedSize: 20 * 1024 * 1024, // 20 MB safety limit
    InternalStreamSafetyLimit: 10 * 1024 * 1024,   // 10 MB for ILS resources
    RowBytesPaddingThreshold: 32,
    ExtendedRowBytesPaddingThreshold: 64,
    MaxCastSlots: 32768
};
