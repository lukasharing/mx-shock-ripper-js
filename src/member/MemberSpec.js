/**
 * @version 1.2.2
 * MemberSpec.js - Type-specific binary metadata parsers
 * 
 * Each class provides a static 'parse' method for a specific Cast Member type payload.
 * These structures align with the legacy Director 4.x - MX 2004 specifications.
 */

class BitmapSpec {
    /**
     * Payload: [Flags2][InitialRect][RegPointLegacy][RegPoint][PaletteRef][Flags2][Depth][AlphaRef][CompType]
     */
    static parse(ds, len) {
        if (len < 16) return {};
        const flags1 = ds.readUint16();
        const initialRect = ds.readRect();
        const regLegacy = ds.readPoint();
        const regPoint = ds.readPoint();

        const height = initialRect.bottom - initialRect.top;
        const width = initialRect.right - initialRect.left;

        let paletteId = 0, bitDepth = 8, flags2 = 0, alphaCastId = -1, compression = 0;
        if (len >= 24) {
            paletteId = ds.readInt16();
            flags2 = ds.readUint16();
            bitDepth = ds.readInt16();
        }
        if (len >= 28) {
            alphaCastId = ds.readInt16();
            compression = ds.readInt16();
        }

        return {
            height, width, regPoint, paletteId, bitDepth,
            _castFlags: flags1,
            _initialRect: initialRect,
            _regLegacy: regLegacy,
            _flags2: flags2, _alphaCastId: alphaCastId, _compression: compression
        };
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
