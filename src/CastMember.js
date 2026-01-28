/**
 * @version 1.2.2
 * CastMember.js - Metadata & geometric state for a single Cast Member
 * 
 * This class encapsulates the dual-nature of Director resources: the standardized 
 * metadata (Common Info) and the type-specific binary payload (Spec). 
 * It provides a unified interface for accessing properties regardless of the 
 * underlying member type (Bitmap, Sound, Lingo, etc.).
 */

const DataStream = require('./utils/DataStream');
const { MemberType } = require('./Constants');

class CastMember {
    /**
     * @param {number} id - The logical resource ID
     * @param {object} chunk - Optional reference to the physical chunk
     * @param {object} properties - Merged properties from metadata parsers
     */
    constructor(id, chunk, properties = {}) {
        this.id = id;
        this.chunk = chunk;
        this.typeId = properties.typeId || 0;
        this.type = properties.type || CastMember.getTypeName(this.typeId);
        this.name = properties.name || '';

        // Geometric Properties
        this.rect = properties.rect || { top: 0, left: 0, bottom: 0, right: 0 };
        this.regPoint = properties.regPoint || { x: 0, y: 0 };

        // Scripting Properties
        this.scriptText = properties.scriptText || '';
        this.scriptId = properties.scriptId || 0;
        this.scriptType = properties.scriptType || 0;

        // Metadata & Flags
        this.flags = properties.flags || 0;
        this.paletteId = properties.paletteId !== undefined ? properties.paletteId : 0;
        this.created = properties.created || null;
        this.modified = properties.modified || null;
        this.comment = properties.comment || null;
        this.bitDepth = properties.bitDepth || 8;

        // Internal Tracking Properties (Post-Processed)
        this.width = properties.width || 0;
        this.height = properties.height || 0;
        this.scriptFile = null;
        this.palette = properties.palette || null;
        this.checksum = properties.checksum || null;

        // Shape specifics
        this.shapeType = properties.shapeType;
        this.pattern = properties.pattern;
        this.foreColor = properties.foreColor;
        this.backColor = properties.backColor;
        this.lineSize = properties.lineSize;
        this.lineDir = properties.lineDir;
    }

    /**
     * Maps numerical TypeIDs to human-readable strings.
     */
    static getTypeName(typeId) {
        const typeMap = {
            [MemberType.Bitmap]: 'Bitmap',
            [MemberType.FilmLoop]: 'FilmLoop',
            [MemberType.Text]: 'Text',
            [MemberType.Palette]: 'Palette',
            [MemberType.Picture]: 'Picture',
            [MemberType.Sound]: 'Sound',
            [MemberType.Button]: 'Button',
            [MemberType.Shape]: 'Shape',
            [MemberType.Movie]: 'Movie',
            [MemberType.DigitalVideo]: 'DigitalVideo',
            [MemberType.Script]: 'Script',
            [MemberType.RTE]: 'RTE',
            [MemberType.Field]: 'Field',
            [MemberType.Transition]: 'Transition',
            [MemberType.Xtra]: 'Xtra',
            [MemberType.Font]: 'Font',
            [MemberType.Mesh]: 'Mesh',
            [MemberType.VectorShape]: 'VectorShape',
            [MemberType.Flash]: 'Flash',
            [MemberType.Bitmap_53]: 'Bitmap (Type 53)',
            [MemberType.Unknown_121]: 'Unknown (Type 121)',
            [MemberType.Unknown_638]: 'Unknown (Type 638)',
            [MemberType.Unknown_2049]: 'Unknown (Type 2049)'
        };
        return typeMap[typeId] || `Unknown(${typeId})`;
    }

    /**
     * Orchestrates the parsing of a CASt chunk by delegating to Info and Spec parsers.
     * @param {number} id - Chunk ID
     * @param {Buffer} buffer - Raw CASt payload
     * @param {string} preferredEndianness - Context-inherited endianness
     */
    static fromChunk(id, buffer, preferredEndianness = 'big') {
        const ds = new DataStream(buffer, preferredEndianness);
        if (buffer.length < 12) return new CastMember(id, null);

        let typeId = ds.readUint32();
        let infoLen = ds.readUint32();
        let specLen = ds.readUint32();

        // Runtime Endianness Calibration
        if (typeId > 0xFFFF) {
            const swappedDS = new DataStream(buffer, preferredEndianness === 'big' ? 'little' : 'big');
            typeId = swappedDS.readUint32();
            infoLen = swappedDS.readUint32();
            specLen = swappedDS.readUint32();
            ds.endianness = swappedDS.endianness;
        }

        const props = { typeId, type: this.getTypeName(typeId), endianness: ds.endianness };

        if (infoLen > 0 && ds.position + infoLen <= buffer.length) {
            Object.assign(props, this._parseCommonInfo(ds.readBytes(infoLen), ds.endianness, typeId));
        }

        if (specLen > 0 && ds.position + specLen <= buffer.length) {
            Object.assign(props, this._parseTypeSpec(ds.readBytes(specLen), ds.endianness, typeId));
        }

        return new CastMember(id, null, props);
    }

    /**
     * Parses the standardized common property block found in all members.
     */
    static _parseCommonInfo(buffer, endianness, typeId) {
        const ds = new DataStream(buffer, endianness);
        if (buffer.length < 20) return {};

        const dataOffset = ds.readUint32();
        const unk1 = ds.readUint32();
        const unk2 = ds.readUint32();
        const flags = ds.readUint32();
        const scriptId = ds.readUint32();

        const props = { flags, scriptId };

        if (buffer.length >= 28) {
            props.created = ds.readUint32();
            props.modified = ds.readUint32();
        }

        if (dataOffset > 0 && dataOffset < buffer.length) {
            Object.assign(props, this._parsePropertyTable(ds, dataOffset, buffer.length));
        }

        return props;
    }

    /**
     * Parses the variable-length property table containing names, scripts, and comments.
     */
    static _parsePropertyTable(ds, offset, totalLen) {
        ds.seek(offset);
        if (ds.position + 2 > totalLen) return {};

        const tableLen = ds.readUint16();
        const offsets = [];
        for (let i = 0; i < tableLen; i++) {
            if (ds.position + 4 > totalLen) break;
            offsets.push(ds.readUint32());
        }

        if (ds.position + 4 > totalLen) return {};
        const itemsLen = ds.readUint32();
        const base = ds.position;

        const readItem = (idx) => {
            if (idx >= offsets.length) return null;
            const start = offsets[idx];
            const end = (idx + 1 < offsets.length) ? offsets[idx + 1] : itemsLen;
            if (start >= end || base + end > totalLen) return null;
            ds.seek(base + start);
            return ds.readBytes(end - start);
        };

        const res = {};
        const item0 = readItem(0);
        if (item0) res.scriptText = item0.toString('utf8');

        const item1 = readItem(1);
        if (item1 && item1.length > 0) {
            const nameLen = item1[0];
            res.name = item1.slice(1, 1 + nameLen).toString('utf8').trim();
        }

        const item4 = readItem(4);
        if (item4) res.comment = item4.toString('utf8').trim();

        return res;
    }

    /**
     * Dispatches Spec parsing to specialized member types.
     */
    static _parseTypeSpec(buffer, endianness, typeId) {
        const ds = new DataStream(buffer, endianness);
        const Specs = require('./member/MemberSpec');

        switch (typeId) {
            case MemberType.Bitmap: return Specs.BitmapSpec.parse(ds, buffer.length);
            case MemberType.Text:
            case MemberType.Field: return Specs.TextSpec.parse(ds, buffer.length);
            case MemberType.Shape: return Specs.ShapeSpec.parse(ds, buffer.length);
            case MemberType.Script: return Specs.ScriptSpec.parse(ds, buffer.length);
            case MemberType.Movie:
            case MemberType.FilmLoop: return Specs.MovieSpec.parse(ds, buffer.length);
            case MemberType.Button: return Specs.ButtonSpec.parse(ds, buffer.length);
            case MemberType.Sound: return Specs.SoundSpec.parse(ds, buffer.length);
            case MemberType.Transition: return Specs.TransitionSpec.parse(ds, buffer.length);
            case MemberType.Xtra: return Specs.XtraSpec.parse(ds, buffer.length);
            case MemberType.Palette: return Specs.PaletteSpec.parse(ds, buffer.length);
            default: return {};
        }
    }

    toJSON() {
        const obj = {
            id: this.id,
            name: this.name,
            type: this.type,
            width: this.width,
            height: this.height,
            regPoint: this.regPoint,
            scriptId: this.scriptId,
            paletteId: this.paletteId,
            bitDepth: this.bitDepth,
            created: this.created,
            modified: this.modified,
            flags: this.flags,
            scriptFile: this.scriptFile,
            palette: (this.palette && !Array.isArray(this.palette)) ? this.palette : undefined,
            shapeType: this.shapeType,
            pattern: this.pattern,
            foreColor: this.foreColor,
            backColor: this.backColor,
            lineSize: this.lineSize,
            lineDir: this.lineDir,
            scriptType: this.scriptType,
            checksum: this.checksum
        };

        if (this.images) obj.images = this.images;
        if (this.image) obj.image = this.image;
        if (this.rect && (this.rect.right !== 0 || this.rect.bottom !== 0)) obj.rect = this.rect;

        // Prune empty or redundant fields for production JSON
        return Object.fromEntries(
            Object.entries(obj).filter(([k, v]) => {
                if (['id', 'name', 'type'].includes(k)) return true;
                return v !== null && v !== undefined && v !== '';
            })
        );
    }
}

module.exports = CastMember;
