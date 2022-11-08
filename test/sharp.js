import {
	readFile,
	writeFile,
} from 'fs/promises';
import sharp from 'sharp';


const buffer = await readFile('import/IMG_8118.JPG');
await writeFile('test.avif', await sharp(buffer).toFormat('avif').toBuffer());