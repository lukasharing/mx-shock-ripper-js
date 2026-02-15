/**
 * @version 1.3.7
 * Logger.js - Standardized logging infrastructure
 */

class Logger {
    /**
     * @param {string} prefix - Optional prefix for log messages (e.g. 'DirectorFile')
     * @param {Function} externalLogger - Optional external logging callback (lvl, msg)
     */
    constructor(prefix = '', externalLogger = null) {
        this.prefix = prefix ? `[${prefix}]` : '';
        this.externalLogger = externalLogger;
    }

    log(lvl, msg) {
        const timestamp = new Date().toISOString();
        const formattedMsg = `${this.prefix}[${lvl}] ${msg}`;

        if (this.externalLogger) {
            this.externalLogger(lvl, msg);
        } else {
            const color = this._getColor(lvl);
            console.log(`${color}${formattedMsg}\x1b[0m`);
        }

        return { timestamp, lvl, msg: formattedMsg };
    }

    _getColor(lvl) {
        switch (lvl) {
            case 'ERROR': return '\x1b[31m'; // Red
            case 'SUCCESS': return '\x1b[32m'; // Green
            case 'WARN':
            case 'WARNING': return '\x1b[33m'; // Yellow
            case 'INFO': return '\x1b[36m'; // Cyan
            default: return '\x1b[0m';
        }
    }

    /**
     * Creates a sub-logger with an extended prefix.
     */
    child(subPrefix) {
        const newPrefix = this.prefix ? `${this.prefix.slice(1, -1)}:${subPrefix}` : subPrefix;
        return new Logger(newPrefix, this.externalLogger);
    }
}

module.exports = Logger;
