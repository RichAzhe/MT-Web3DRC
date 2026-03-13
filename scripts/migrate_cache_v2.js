const fs = require('fs');
const path = require('path');

const cacheDir = path.join(__dirname, '../cache');
const baseModelName = '54%'; // Assuming this is the only base model for now

async function migrate() {
    if (!fs.existsSync(cacheDir)) {
        console.log('Cache directory not found.');
        return;
    }

    const files = fs.readdirSync(cacheDir);
    let count = 0;

    for (const file of files) {
        if (file.startsWith('grid_')) {
            const match = file.match(/^grid_(-?\d+)_(-?\d+)$/);
            if (match) {
                const x = match[1];
                const z = match[2];
                const newName = `${baseModelName}_copy_${x}_${z}`;
                const oldPath = path.join(cacheDir, file);
                const newPath = path.join(cacheDir, newName);

                if (fs.existsSync(newPath)) {
                    console.log(`Target ${newName} already exists. Skipping/Merging...`);
                    // Optional: Merge or delete old
                } else {
                    try {
                        fs.renameSync(oldPath, newPath);
                        console.log(`Renamed ${file} -> ${newName}`);
                        count++;
                    } catch (e) {
                        console.error(`Failed to rename ${file}:`, e);
                    }
                }
            }
        }
    }

    console.log(`Migration complete. Renamed ${count} folders.`);
}

migrate();
