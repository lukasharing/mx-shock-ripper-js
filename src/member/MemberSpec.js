/**
 * @version 1.3.7
 * MemberSpec.js - Type-specific binary metadata parsers
 */

class BitmapSpec {
    /**
     * Payload: [Flags1(4)][InitialRect(8)][RegPointLegacy(4)][RegPoint(4)][PaletteId(2)][Flags2(2)][Depth(2)][AlphaRef(2)]
     */
    static parse(ds, len) {
        if (len < 10) return {};
        const startPos = ds.position;

        const pitchRaw = ds.readUint16(); // Offset 0
        const isColor = (pitchRaw & 0x8000) !== 0;
        const pitch = pitchRaw & 0x3FFF;

        const initialRect = ds.readRect(); // Offset 2

        // Safe seek and read (standard length is 24-28 bytes)
        let regY = 0, regX = 0, updateFlags = 0, bitDepth = 8;
        if (len >= 22) {
            ds.seek(startPos + 18);
            regY = ds.readInt16(); // Offset 18
            regX = ds.readInt16(); // Offset 20
            if (len >= 24) {
                updateFlags = ds.readUint8(); // Offset 22
                bitDepth = ds.readUint8();    // Offset 23
            }
        }

        let clutCastLib = -1;
        let clutId = 0;

        if (len >= 28 && (isColor || ds.position + 4 <= startPos + len)) {
            clutCastLib = ds.readInt16(); // Offset 24
            clutId = ds.readInt16();      // Offset 26

            // Normalize built-in palette IDs (-1 offset)
            if (clutId <= 0) {
                clutId -= 1;
            }
        }

        const height = Math.abs(initialRect.bottom - initialRect.top);
        const width = Math.abs(initialRect.right - initialRect.left);

        const res = {
            height: height || 1,
            width: width || 1,
            regPoint: { x: regX, y: regY },
            paletteId: clutId,      // Map clutId to paletteId for compatibility
            clutCastLib,
            bitDepth: bitDepth || 8,
            _pitch: pitch,
            _isColor: isColor,
            _updateFlags: updateFlags,
            _initialRect: initialRect,
            _castFlags: pitchRaw,   // Store raw pitch as castFlags for legacy checks
            secondaryPaletteId: clutId // Keep secondaryPaletteId for now
        };
        return res;
    }
}

class ShapeSpec {
    static parse(ds, len) {
        if (len < 22) return {};
        const flags = ds.readUint16();
        const rect = ds.readRect();
        const shapeType = ds.readInt16();
        const pattern = ds.readInt16();
        const foreColor = ds.readUint16();
        const backColor = ds.readUint16();
        const lineSize = ds.readInt16();
        const lineDir = ds.readInt16();

        return {
            rect,
            width: rect.right - rect.left,
            height: rect.bottom - rect.top,
            shapeType,
            pattern,
            foreColor,
            backColor,
            lineSize,
            lineDir,
            _castFlags: flags
        };
    }
}

class TextSpec {
    static parse(ds, len) {
        if (len < 8) return {};
        return { rect: ds.readRect() };
    }
}

class ScriptSpec {
    static parse(ds, len) {
        return len < 2 ? {} : { scriptType: ds.readUint16() };
    }
}

class MovieSpec {
    static parse(ds, len) {
        if (len < 12) return {};
        return {
            _castFlags: ds.readUint16(),
            rect: ds.readRect()
        };
    }
}

class ButtonSpec {
    static parse(ds, len) {
        if (len < 12) return {};
        const flags = ds.readUint16();
        const rect = ds.readRect();
        const buttonType = ds.readInt16();
        return { rect, buttonType, _castFlags: flags };
    }
}

class SoundSpec {
    static parse(ds, len) {
        if (len < 10) return {};
        return {
            _castFlags: ds.readUint16(),
            sampleRate: ds.readUint32(),
            bitDepth: ds.readUint16(),
            channels: ds.readUint16()
        };
    }
}

class TransitionSpec {
    static parse(ds, len) {
        if (len < 14) return {};
        return {
            _castFlags: ds.readUint16(),
            duration: ds.readUint16(),
            chunkSize: ds.readUint16(),
            transitionType: ds.readUint16()
        };
    }
}

class XtraSpec {
    static parse(ds, len) {
        if (len < 4) return {};
        return {
            _castFlags: ds.readUint16(),
            xtraId: ds.readUint16()
        };
    }
}

class PaletteSpec {
    static parse(ds, len) {
        if (len < 2) return {};
        return { _castFlags: ds.readUint16() };
    }
}

module.exports = { BitmapSpec, ShapeSpec, TextSpec, ScriptSpec, MovieSpec, ButtonSpec, SoundSpec, TransitionSpec, XtraSpec, PaletteSpec };
