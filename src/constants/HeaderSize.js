/**
 * @version 1.2.8
 * HeaderSize.js - Byte lengths for various chunk/asset headers
 */

module.exports = {
    StandardChunk: 8,    // 4 bytes FourCC + 4 bytes Length
    MinimumMember: 12,   // Minimum size for a member metadata block
    Bitd: 10,            // Bitmap Data header length
    Stxt: 12,            // Script Text header length
    Field: 12            // Field Text header length
};
