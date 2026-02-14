/**
 * @version 1.3.5
 * CastMember.js - Metadata & geometric state for a single Cast Member
 */

const DataStream = require('./utils/DataStream');
const { MemberType, Offsets } = require('./Constants');
const Specs = require('./member/MemberSpec');
const DirectorFile = require('./DirectorFile');

class CastMember {
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
        this.scriptLength = properties.scriptLength || null;

        // Metadata & Flags
        this.flags = properties.flags || 0;
        this.paletteId = properties.paletteId !== undefined ? properties.paletteId : 0;
        this.created = properties.created || null;
        this.modified = properties.modified || null;
        this.comment = properties.comment || null;
        this.bitDepth = properties.bitDepth || 8;
        this.format = properties.format || null;

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

        // Enrichment: apply all properties to the instance
        this.mergeProperties(properties);
    }

    /**
     * Smart property merging that respects current non-default values.
     */
    mergeProperties(properties) {
        if (!properties) return;
        for (const [k, v] of Object.entries(properties)) {
            if (v !== undefined && v !== null) {
                // Priority Merging Strategy:
                // 1. If currently 0/8 or default, always take the new value.
                // 2. If it's a generic "member_ID" name, allow overwriting with a descriptive name.
                const isGenericName = k === 'name' && this[k] && this[k].startsWith('member_');
                if (this[k] === 0 || this[k] === 8 || !this[k] || isGenericName) {
                    this[k] = v;
                } else if (k === 'width' || k === 'height' || k === 'bitDepth' || k === 'typeId' || k === 'type') {
                    // Always overwrite critical fields IF the new value is non-zero
                    if (v && v !== 0 && v !== 8) this[k] = v;
                } else if (this[k] === undefined) {
                    this[k] = v;
                }
            }
        }
    }

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

    static fromChunk(id, buffer, preferredEndianness = 'big') {
        const ds = new DataStream(buffer, preferredEndianness);
        if (buffer.length < Offsets.Cast.HeaderSize) return new CastMember(id, null);

        let typeId = ds.readUint32();
        let infoLen = ds.readUint32();
        let specLen = ds.readUint32();

        if (typeId > 0xFFFF) {
            const swappedDS = new DataStream(buffer, preferredEndianness === 'big' ? 'little' : 'big');
            typeId = swappedDS.readUint32();
            infoLen = swappedDS.readUint32();
            specLen = swappedDS.readUint32();
            ds.endianness = swappedDS.endianness;
        }

        const props = { typeId, type: this.getTypeName(typeId), endianness: ds.endianness };

        if (infoLen > 0 && ds.position + infoLen <= buffer.length) {
            Object.assign(props, this._parseCommonInfo(id, ds.readBytes(infoLen), ds.endianness, typeId));
        }

        if (specLen > 0 && ds.position + specLen <= buffer.length) {
            const specBuf = ds.readBytes(specLen);
            props._rawSpec = specBuf;
            Object.assign(props, this._parseTypeSpec(specBuf, ds.endianness, typeId));
        }

        return new CastMember(id, null, props);
    }

    static _parseCommonInfo(id, buffer, endianness, typeId) {
        const ds = new DataStream(buffer, endianness);
        if (buffer.length < Offsets.KeyTableStandard) return {};

        const dataOffset = ds.readUint32();
        const unk1 = ds.readUint32();
        const nameIdx = ds.readUint32(); // Index into LNAM pool
        const flags = ds.readUint32();
        const scriptId = ds.readUint32();

        const props = { flags, scriptId, nameIdx };

        if (buffer.length >= 28) {
            props.created = ds.readUint32();
            props.modified = ds.readUint32();
        }

        if (dataOffset > 0 && dataOffset < buffer.length) {
            Object.assign(props, this._parsePropertyTable(id, ds, dataOffset, buffer.length));
        }

        return props;
    }

    static _parsePropertyTable(id, ds, offset, totalLen) {
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

        let memberName = 'unknown';
        const res = {};
        for (let i = 0; i < offsets.length; i++) {
            const item = readItem(i);
            if (item) {

                // The provided snippet seems to be out of context for this method.
                // It refers to `this.chunks` and `bitmapId` which are not available here.
                // The instruction "Store rawSpec in the member object" has been handled in `fromChunk`.
                // Keeping the original logic for parsing properties from the table.

                if (i === 1 && item.length > 0) {
                    const nameLen = item[0];
                    if (nameLen > 0 && nameLen < item.length) {
                        memberName = item.slice(1, 1 + nameLen).toString('utf8').trim();
                        if (memberName) res.name = memberName;
                    }
                }

                if (i === 0) res.scriptText = item.toString('utf8');
                if (i === 4) res.comment = item.toString('utf8').trim();

                if (i === 5 && item.length >= 2) {
                    let pid = item.readInt16BE(0);
                    // Normalize built-in palette IDs (-1 offset)
                    // 0 -> -1 (Mac), -1 -> -2 (Rainbow), -2 -> -3 (Grayscale)
                    if (pid <= 0) pid -= 1;
                    res.paletteId = pid;
                }
                if (i === 6 && item.length >= 2) res.bitDepth = item.readInt16BE(0);
            }
        }

        return res;
    }

    static _parseTypeSpec(buffer, endianness, typeId) {
        const ds = new DataStream(buffer, endianness);

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
            palette: (this.palette && !Array.isArray(this.palette)) ? this.palette : undefined,
            shapeType: this.shapeType,
            pattern: this.pattern,
            foreColor: this.foreColor,
            backColor: this.backColor,
            lineSize: this.lineSize,
            lineDir: this.lineDir,
            scriptType: this.scriptType,
            scriptLength: this.scriptLength,
            format: this.format,
            _compression: this._compression,
            _castFlags: this._castFlags,
            _alphaCastId: this._alphaCastId,
            checksum: this.checksum
        };
        if (this.rect && (this.rect.right !== 0 || this.rect.bottom !== 0)) obj.rect = this.rect;
        return Object.fromEntries(
            Object.entries(obj).filter(([k, v]) => {
                if (['id', 'name', 'type'].includes(k)) return true;
                return v !== null && v !== undefined && v !== '';
            })
        );
    }
}

module.exports = CastMember;
