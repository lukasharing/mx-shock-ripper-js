const fs = require('fs');
const path = require('path');
const { MemberType, Magic, AfterburnerTags, LingoConfig } = require('../Constants');

class ScriptHandler {
    constructor(extractor) {
        this.extractor = extractor;
    }

    async handleScripts(member, memberKey) {
        if (!this.extractor.options.extractScript) return;

        const { text, source: textSource } = await this._resolveScriptSource(member, memberKey);

        if (text && text.trim() && member.typeId !== MemberType.Script) {

            const outPath = path.join(this.extractor.outputDir, `${member.name}`);
            const res = this.extractor.scriptExtractor.save(text, outPath, member);
            if (res) {
                member.format = 'ls';
                member.scriptLength = res.scriptLength;
                member.scriptSource = textSource;
            }
            return;
        }

        const potentialKeys = [memberKey];
        if (member.scriptId > 0 && this.extractor.metadataManager.keyTable[member.scriptId])
            potentialKeys.push(this.extractor.metadataManager.keyTable[member.scriptId]);

        const { lscrId, source: lscrSource } = this._resolveLscrChunk(member, potentialKeys);

        if (lscrId) {
            const decompiled = await this._decompileLscr(lscrId, lscrSource, member);
            // If decompilation failed (contains error marker) and it's a Text/Field member,
            // assume the script is irrelevant/garbage and don't attach it to the member metadata.
            const isTextOrField = [MemberType.Text, MemberType.Field].includes(member.typeId);
            const failure = (typeof decompiled === 'string') ? decompiled.includes('[DECOMPILE ERROR') : (decompiled?.text?.includes('[DECOMPILE ERROR'));

            if (failure && isTextOrField) {
                this.extractor.log('WARNING', `Member ID ${member.id} (${member.name}): Ignoring failed decompilation for Text member.`);
                // No need to delete scriptFile as we don't set it anymore on member
            }
        } else if (member.typeId === MemberType.Script) {
            this.extractor.log('WARNING', `Member ID ${member.id} (Script): No script chunks found.`);
        }
    }

    async _resolveScriptSource(member, memberKey) {
        let text = member.scriptText;
        let source = text ? 'Member Metadata' : null;

        // ONLY Script members treat STXT/TEXT chunks as source code.
        // For Text/Field members, these chunks are content (handled by TextExtractor).
        if (!text && member.typeId === MemberType.Script) {
            const potentialKeys = [memberKey];
            if (member.scriptId > 0 && this.extractor.metadataManager.keyTable[member.scriptId])
                potentialKeys.push(this.extractor.metadataManager.keyTable[member.scriptId]);

            for (const key of potentialKeys) {
                if (!key) continue;
                const textId = key[Magic.STXT] || key[Magic.TEXT] || key['STXT'] || key['TEXT'];
                if (!textId) continue;

                const chunk = this.extractor.dirFile.getChunkById(textId);
                if (!chunk) continue;

                const buf = await this.extractor.dirFile.getChunkData(chunk);
                if (buf) {
                    text = this.extractor.textExtractor.extract(buf);
                    source = chunk.type;
                    break;
                }
            }
        }
        return { text, source };
    }

    _resolveLscrChunk(member, potentialKeys) {
        let lscrId = 0;
        let source = null;

        if (member.scriptId > 0 && this.extractor.metadataManager.lctxMap[member.scriptId]) {
            lscrId = this.extractor.metadataManager.lctxMap[member.scriptId];
            source = 'Lscr (LctX)';
        } else if (member.id > 0 && this.extractor.metadataManager.lctxMap[member.id]) {
            lscrId = this.extractor.metadataManager.lctxMap[member.id];
            source = 'Lscr (LctX)';
        }

        if (!lscrId) {
            for (const key of potentialKeys) {
                if (!key) continue;
                lscrId = key[Magic.LSCR] || key[AfterburnerTags.rcsL] || key['Lscr'] || key['rcsL'];
                if (lscrId) {
                    source = 'Lscr (KeyTable)';
                    break;
                }
            }
        }

        if (!lscrId && member.scriptChunkId) {
            lscrId = member.scriptChunkId;
            source = 'Lscr (Heuristic)';
        }

        return { lscrId, source };
    }

    async _decompileLscr(lscrId, source, member) {
        const chunk = this.extractor.dirFile.getChunkById(lscrId);
        const lscrData = chunk ? await this.extractor.dirFile.getChunkData(chunk) : null;
        if (!lscrData) return;

        this.extractor.log('INFO', `Member ID ${member.id}: Decompiling Bytecode from ${source}...`);

        let names = this.extractor.metadataManager.nameTable;
        if (chunk) {
            const idx = this.extractor.dirFile.chunks.indexOf(chunk);
            if (idx !== -1) {
                for (let i = idx; i >= 0; i--) {
                    const c = this.extractor.dirFile.chunks[i];
                    const type = c.type.toUpperCase();
                    if ([Magic.LNAM.toUpperCase(), AfterburnerTags.manL.toUpperCase()].includes(type)) {
                        try {
                            const lnamData = await this.extractor.dirFile.getChunkData(c);
                            const localNames = this.extractor.lnamParser.parse(lnamData);
                            if (localNames && Object.keys(localNames).length > 0) names = localNames;
                        } catch (e) {
                            this.extractor.log('WARNING', `Failed to parse Context Lnam ${c.id}: ${e.message}`);
                        }
                        break;
                    }
                }
            }
        }

        const decompiled = this.extractor.lingoDecompiler.decompile(lscrData, names, member.scriptType, member.id, { lasm: this.extractor.options.lasm });
        const decompiledText = (typeof decompiled === 'object') ? decompiled.text || decompiled.source : decompiled;

        if (decompiledText) {
            const outPath = path.join(this.extractor.outputDir, `${member.name}.ls`);
            fs.writeFileSync(outPath, decompiledText);
            member.format = 'ls';
            member.scriptSource = `${source} (Decompiled)`;
            member.scriptLength = decompiledText.length;

            // LASM is redundant for standard extraction, removing per requirements
            /*
            if (this.extractor.options.lasm && decompiled.lasm) {
                const lasmPath = path.join(this.extractor.outputDir, `${member.name}.lasm`);
                fs.writeFileSync(lasmPath, decompiled.lasm);
                member.lasmFile = `${member.name}.lasm`;
            }
            */

            if (decompiledText.includes(LingoConfig.Labels.ProtectedScript)) {
                this.extractor.stats.protectedScripts = (this.extractor.stats.protectedScripts || 0) + 1;
            }
            return { format: 'ls' };
        } else {
            this.extractor.log('WARNING', `Member ID ${member.id}: Decompilation failed. Saving raw bytecode.`);
            const lscPath = path.join(this.extractor.outputDir, `${member.name}.lsc`);
            this.extractor.genericExtractor.save(lscrData, lscPath, member);
            member.scriptSource = `${source} (Raw)`;
            member.format = 'lsc';
            return { format: 'lsc' };
        }
    }
}

module.exports = ScriptHandler;
