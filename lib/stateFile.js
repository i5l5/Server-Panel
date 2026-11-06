const fs = require('fs');
const path = require('path');


module.exports = function stateFile(filename, defaults) {
  let data;
  try { data = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (err) { if (err.code !== 'ENOENT') throw err; data = defaults; }
  return {
    data,
    save() {
      fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
      const temp = `${filename}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.renameSync(temp, filename);
    }
  };
};
