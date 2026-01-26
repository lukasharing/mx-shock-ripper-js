/**
 * @version 1.1.2
 * CastMember.js - Archetypal model for Adobe Director resources
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
        this.paletteId = properties.paletteId || 0;
        this.created = properties.created || null;
        this.modified = properties.modified || null;
        this.comment = properties.comment || null;
        this.bitDepth = properties.bitDepth || 8;

        // Internal Tracking Properties (Post-Processed)
        this.width = properties.width || 0;
        this.height = properties.height || 0;
        this.scriptFile = null;
        this.paletteFile = null;
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
            [MemberType.Flash]: 'Flash'
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
            ds.endianness = ds.endianness === 'big' ? 'little' : 'big';
            ds.seek(0);
            typeId = ds.readUint32();
            infoLen = ds.readUint32();
            specLen = ds.readUint32();
        }

        const props = { typeId, type: this.getTypeName(typeId), endianness: ds.endianness };

        if (infoLen > 0 && ds.position + infoLen <= buffer.length) {
            Object.assign(props, this._parseCommonInfo(ds.readBytes(infoLen), ds.endianness));
        }

        if (specLen > 0 && ds.position + specLen <= buffer.length) {
            Object.assign(props, this._parseTypeSpec(ds.readBytes(specLen), ds.endianness, typeId));
        }

        return new CastMember(id, null, props);
    }

    /**
     * Parses the standardized common property block found in all members.
     */
    static _parseCommonInfo(buffer, endianness) {
        const ds = new DataStream(buffer, endianness);
        if (buffer.length < 20) return {};

        const propertyTableOffset = ds.readUint32();
        const linkedCastId = ds.readUint32(); // Reference to external cast source
        const sequenceId = ds.readUint32();   // Order in origin sequence
        const flags = ds.readUint32();
        const scriptId = ds.readUint32();

        const props = { flags, scriptId, linkedCastId, sequenceId };

        if (buffer.length >= 28) {
            props.created = ds.readUint32();
            props.modified = ds.readUint32();
        }

        if (propertyTableOffset > 0 && propertyTableOffset < buffer.length) {
            Object.assign(props, this._parsePropertyTable(ds, propertyTableOffset, buffer.length));
        }

        return props;
    }

    /**
     * Parses the variable-length property table containing names, scripts, and comments.
     */
    static _parsePropertyTable(ds, offset, totalLen) {
        ds.seek(offset);
        if (ds.position + 2 > totalLen) return {};

        const entryCount = ds.readUint16();
        const offsets = [];
        for (let i = 0; i < entryCount; i++) {
            if (ds.position + 4 > totalLen) break;
            offsets.push(ds.readUint32());
        }

        if (ds.position + 4 > totalLen) return {};
        const stringPoolSize = ds.readUint32();
        const poolBase = ds.position;

        const readStringAt = (idx) => {
            if (idx >= offsets.length) return null;
            const start = offsets[idx];
            const end = (idx + 1 < offsets.length) ? offsets[idx + 1] : stringPoolSize;
            if (start >= end || poolBase + end > totalLen) return null;
            ds.seek(poolBase + start);
            return ds.readBytes(end - start);
        };

        const res = {};
        const scriptData = readStringAt(0);
        if (scriptData) res.scriptText = scriptData.toString('utf8');

        const nameData = readStringAt(1);
        if (nameData && nameData.length > 0) {
            const nameLen = nameData[0];
            res.name = nameData.slice(1, 1 + nameLen).toString('utf8').trim();
        }

        const commentData = readStringAt(4);
        if (commentData) res.comment = commentData.toString('utf8').trim();

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
            paletteFile: this.paletteFile,
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
            Object.entries(obj).filter(([_, v]) => v !== null && v !== undefined && v !== '')
        );
    }
}

module.exports = CastMember;
