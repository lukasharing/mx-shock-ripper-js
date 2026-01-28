const fs = require('fs');
const path = require('path');
const { MemberType, Magic, AfterburnerTags, LingoConfig } = require('../Constants');

class ScriptHandler {
    constructor(extractor) {
        this.extractor = extractor;
    }

    async handleScripts(member, memberKey) {
        if (!this.extractor.options.extractScript) return;

        const { text, source: textSource } = await this._resolveScriptText(member, memberKey);

        if (text && text.trim() && member.typeId !== MemberType.Script) {
            this.extractor.log('DEBUG', `Member ${member.name}: Saving script from ${textSource} chunk source.`);
            const outPath = path.join(this.extractor.outputDir, `${member.name}`);
            const res = this.extractor.scriptExtractor.save(text, outPath, member);
            if (res) {
                member.scriptFile = res.scriptFile;
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
            await this._decompileLscr(lscrId, lscrSource, member);
        } else if (member.typeId === MemberType.Script) {
            this.extractor.log('WARNING', `Member ID ${member.id} (Script): No script chunks found.`);
        }
    }

    async _resolveScriptText(member, memberKey) {
        let text = member.scriptText;
        let source = text ? 'Member Metadata' : null;

        if (!text) {
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
            member.scriptFile = `${member.name}.ls`;
            member.scriptSource = `${source} (Decompiled)`;
            member.scriptLength = decompiledText.length;

            if (this.extractor.options.lasm && decompiled.lasm) {
                const lasmPath = path.join(this.extractor.outputDir, `${member.name}.lasm`);
                fs.writeFileSync(lasmPath, decompiled.lasm);
                member.lasmFile = `${member.name}.lasm`;
            }

            if (decompiledText.includes(LingoConfig.Labels.ProtectedScript)) {
                this.extractor.stats.protectedScripts = (this.extractor.stats.protectedScripts || 0) + 1;
            }
        } else {
            this.extractor.log('WARNING', `Member ID ${member.id}: Decompilation failed. Saving raw bytecode.`);
            const lscPath = path.join(this.extractor.outputDir, `${member.name}.lsc`);
            this.extractor.genericExtractor.save(lscrData, lscPath, member);
            member.scriptFile = `${member.name}.lsc`;
            member.scriptSource = `${source} (Raw)`;
        }
    }
}

module.exports = ScriptHandler;
