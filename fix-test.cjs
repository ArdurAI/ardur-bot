const fs = require('fs');
const content = fs.readFileSync('packages/adapters/src/runtimes/local-hermes-runtime.test.ts', 'utf8');
const lines = content.split('\n');
const start = lines.findIndex(l => l.includes('it("refuses relay after turn end"'));
if (start !== -1) {
    const newLines = lines.slice(0, start);
    // ensure describe is closed
    if (newLines[newLines.length - 1] !== '});') {
        if (newLines[newLines.length - 1] === '});') {}
        else {
            // Check if last line is empty
            if (newLines[newLines.length - 1].trim() === '') {
                newLines[newLines.length - 1] = '});';
            } else {
                newLines.push('});');
            }
        }
    }
    fs.writeFileSync('packages/adapters/src/runtimes/local-hermes-runtime.test.ts', newLines.join('\n'));
}
