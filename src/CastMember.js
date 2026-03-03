/**
 * @version 1.4.2
 * CastMember.js - Metadata & geometric state for a single Cast Member
 */

const DataStream = require('./utils/DataStream');
const { MemberType, Offsets } = require('./Constants');
const Specs = require('./member/MemberSpec');
const DirectorFile = require('./DirectorFile');
const { Palette } = require('./utils/Palette');

class CastMember {
    constructor(id, chunk, properties = {}) {
        this.id = id;
        this.chunk = chunk;
        // The typeId setter will automatically update this.type
        this.typeId = properties.typeId || 0;
        if (properties.type) this.type = properties.type;
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
        this.clutCastLib = properties.clutCastLib || 0;

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

    get typeId() {
        return this._typeId;
    }

    set typeId(val) {
        this._typeId = val;
        this.type = CastMember.getTypeName(val);
    }

    /**
     * Smart property merging that respects current non-default values and prioritizes latest specifications.
     */
    mergeProperties(properties) {
        if (!properties) return;

        for (const [k, v] of Object.entries(properties)) {
            if (v === undefined || v === null) continue;

            // Allow auto-generated placeholder names to be overwritten by real names
            if (k === 'name' && typeof this[k] === 'string' && this[k].startsWith('member_')) {
                this[k] = v;
                continue;
            }

            const isCritical = ['width', 'height', 'bitDepth', 'typeId', '_typeId', 'type'].includes(k);
            const isCurrentlyDefault = !this[k] || this[k] === 0;

            // Update if current value is default/missing, OR if it's a critical field with a non-zero valid update
            if (isCurrentlyDefault || (isCritical && v !== 0)) {
                if (k === '_typeId') {
                    this.typeId = v; // Trigger setter
                } else {
                    this[k] = v;
                }
            }
        }
    }

    static getTypeName(typeId) {
        const typeMap = {
            [MemberType.Null]: 'Null',
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

    static getScriptTypeTag(scriptType) {
        // Director script type values:
        // 0 = Movie script (legacy/unnamed global)
        // 1 = Behavior script (sprite-attached)
        // 2 = Parent script (OOP class)
        // 3 = Movie script (modern global/module)
        // 7 = Cast-level script (legacy D4)
        const tags = { 0: 'movie', 1: 'behavior', 2: 'parent', 3: 'movie', 7: 'cast' };
        return tags[scriptType] || `script-${scriptType}`;
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

        const res = {};
        for (let i = 0; i < offsets.length; i++) {
            const item = readItem(i);
            if (!item || item.length === 0) continue;

            switch (i) {
                case 0:
                    res.scriptText = item.toString('utf8');
                    break;
                case 1:
                    const nameLen = item[0];
                    if (nameLen > 0 && nameLen < item.length) {
                        const memberName = item.slice(1, 1 + nameLen).toString('utf8').trim();
                        if (memberName) res.name = memberName;
                    }
                    break;
                case 4:
                    res.comment = item.toString('utf8').trim();
                    break;
                case 5:
                    if (item.length >= 2) {
                        let pid = item.readInt16BE(0);
                        res.paletteId = Palette.normalizePaletteId(pid);
                    }
                    break;
                case 6:
                    if (item.length >= 2) res.bitDepth = item.readInt16BE(0);
                    break;
                case 10:
                    res.xtraDisplayName = item.toString('utf8').trim();
                    break;
                case 15:
                    if (item.length === 16) {
                        res.guid = item.toString('hex');
                    }
                    break;
                case 16:
                    res.mediaFormatName = item.toString('utf8').trim();
                    break;
                case 17:
                    if (item.length >= 4) res.created = item.readInt32BE(0);
                    break;
                case 18:
                    if (item.length >= 4) res.modifiedTime = item.readInt32BE(0);
                    break;
                case 19:
                    res.modifiedBy = item.toString('utf8').trim();
                    break;
                case 20: // duplicate comment check (fallback)
                    const c = item.toString('utf8').trim();
                    if (c && !res.comment) res.comment = c;
                    break;
                case 21:
                    if (item.length >= 4) res.imageQuality = item.readInt32BE(0);
                    break;
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
        const common = {
            id: this.id,
            name: this.name,
            type: this.type,
            typeId: this.typeId,
            num: this.num, // If available
            modified: this.modified,
            loaded: this.loaded, // If available
            checksum: this.checksum,
            format: this.format,
            scriptFile: this.scriptFile
        };

        // Filter out null/undefined common fields
        const result = Object.fromEntries(
            Object.entries(common).filter(([_, v]) => v !== undefined && v !== null && v !== '')
        );

        // Type-Specific Attributes
        switch (this.typeId) {
            case MemberType.Bitmap: // 1
                if (this._castFlags) result._castFlags = this._castFlags;
                if (this._initialRect) result._initialRect = this._initialRect;
                if (this.width) result.width = this.width;
                if (this.height) result.height = this.height;
                if (this.regPoint) result.regPoint = this.regPoint;
                if (this.bitDepth) result.bitDepth = this.bitDepth;
                if (this.paletteId !== 0) result.paletteId = this.paletteId;
                if (this.clutCastLib !== undefined && this.clutCastLib !== 0) result.clutCastLib = this.clutCastLib;
                break;

            case MemberType.Shape: // 2
            case MemberType.VectorShape: // 10
                result.shapeType = this.shapeType;
                if (this.rect && (this.rect.right !== 0 || this.rect.bottom !== 0)) result.rect = this.rect;
                if (this.pattern) result.pattern = this.pattern;
                if (this.foreColor) result.foreColor = this.foreColor;
                if (this.backColor) result.backColor = this.backColor;
                if (this.lineSize) result.lineSize = this.lineSize;
                result.filled = this.filled; // If available
                break;

            case MemberType.Script: // 11
                result.scriptType = CastMember.getScriptTypeTag(this.scriptType);
                break;

            case MemberType.Text: // 3
            case MemberType.Field: // 12
                if (this.text) result.text = this.text;
                if (this.font) result.font = this.font;
                if (this.size) result.size = this.size;
                if (this.style) result.style = this.style;
                if (this.foreColor) result.foreColor = this.foreColor;
                if (this.backColor) result.backColor = this.backColor;
                if (this.rect && (this.rect.right !== 0 || this.rect.bottom !== 0)) result.rect = this.rect;
                break;

            case MemberType.Palette: // 4
                // Palette members are usually just a list of colors, often large, so we might skip the 'palette' array unless requested.
                // For now, keeping it minimal as per plan.
                break;
        }

        // Always include regPoint for visual members if it exists and wasn't added above
        if (!result.regPoint && this.regPoint && (this.typeId === MemberType.Bitmap || this.typeId === MemberType.Shape || this.typeId === MemberType.VectorShape || this.typeId === MemberType.Flash)) {
            result.regPoint = this.regPoint;
        }

        return result;
    }
}

module.exports = CastMember;
