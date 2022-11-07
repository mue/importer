import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import AWS from 'aws-sdk';
import gradient from 'gradient-string';
import figlet from 'figlet';
import { program } from 'commander';
import { colours } from 'leeks.js';
import fs, { promises as fsp } from 'fs';
import inquirer from 'inquirer';
import Spinnies from 'spinnies';
import fetch from 'node-fetch';
import csv from 'convert-csv-to-json';
import { resolve } from 'path';
import ms from 'ms';
import { createHash } from 'crypto';
import sharp from 'sharp';
import piexif from 'piexifjs';

config();

console.log(gradient('#ffb032', '#dd3b67').multiline(figlet.textSync('Mue Importer', {})));

program
	.option('-c, --category <name>', 'image category', 'outdoors')
	.option('-l, --location <name>', 'fallback location name (if not in EXIF)')
	.option('-p, --photographer <name>', 'photographer name');
program.parse(process.argv);
const options = program.opts();

console.log(colours.greenBright(`Category: ${options.category}`));

if (!options.location) console.log(colours.yellowBright('Warning: no fallback location'));
else console.log(colours.greenBright(`Fallback location: ${options.location}`));

if (!options.photographer) {
	console.log(colours.redBright('Error: no photographer'));
	process.exit(1);
} else {
	console.log(colours.greenBright(`Photographer: ${options.photographer}`));
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET);
const s3 = new AWS.S3({
	credentials: {
		accessKeyId: process.env.S3_ACCESS,
		secretAccessKey: process.env.S3_SECRET,
	},
	endpoint: process.env.S3_ENDPOINT,
	s3ForcePathStyle: true,
	signatureVersion: 'v4',
});

const resolutions = {
	hd: [null, 720],
	fhd: [null, 1080], // eslint-disable-line sort-keys
	qhd: [null, 1440],
	original: null, // eslint-disable-line sort-keys
};
const formats = ['webp', 'avif'];

const variants = Object.entries(resolutions)
	.map(([k, v]) =>
		formats.map(format => ({
			format,
			name: k,
			resolution: v,
		})))
	.flat();

console.log(colours.blueBright(`Variants: ${variants.length}`));

const files = (await fsp.readdir('import', { withFileTypes: true }))
	.filter(file => !file.isDirectory() && !file.name.startsWith('.'))
	.map(file => file.name);

const { start } = await inquirer.prompt([{
	default: !!options.photographer,
	message: `Do you want to continue with ${files.length} files?`,
	name: 'start',
	type: 'confirm',
}]);

if (!start) {
	console.log(colours.redBright('Canceled.'));
	process.exit(1);
}

const spin = new Spinnies({
	spinner: {
		frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
		interval: 80,
	},
});

if (!fs.existsSync('android.json')) {
	spin.add('android1', { text: 'Downloading supported_devices.csv' });
	const res = await fetch('https://storage.googleapis.com/play_public/supported_devices.csv');
	const fileStream = fs.createWriteStream('supported_devices.csv');
	await new Promise((resolve, reject) => {
		res.body.pipe(fileStream);
		res.body.on('error', reject);
		fileStream.on('finish', resolve);
	});
	spin.succeed('android1', { text: 'Downloaded supported_devices.csv' });
	spin.add('android2', { text: 'Processing android.json' });
	let json = csv.fieldDelimiter(',').ucs2Encoding().getJsonFromCsv('supported_devices.csv');
	await fsp.unlink('supported_devices.csv');
	json = json.reduce((json, data) => {
		json[data.Model] = data.MarketingName.startsWith(data.RetailBranding) ? data.MarketingName : data.RetailBranding + ' ' + (data.MarketingName || data.Model);
		return json;
	}, {});
	await fsp.writeFile('android.json', JSON.stringify(json), 'utf8');
	spin.succeed('android2', { text: 'Downloaded android.json' });
}

const android = JSON.parse(await fsp.readFile('android.json'));
const gpsCache = new Map();
const startTime = Date.now();
let count = 0;
spin.add('main', { text: 'Importing images' });
const spinInterval = setInterval(() => {
	spin.update('main', { text: `Importing images (${count}/${files.length}, ${((count / files.length) * 100).toFixed(2)}%) ${ms(Date.now() - startTime)}` });
}, 1000);

files:
for (const file of files) {
	spin.add('main.1', { text: `Reading ${file}` });
	const path = resolve('import', file);
	let buffer = await fsp.readFile(path);
	const binary = buffer.toString('binary');
	const exif = piexif.load(binary);
	buffer = Buffer.from(piexif.remove(binary), 'binary'); // same as `buffer` but without metadata
	const checksum = createHash('md5').update(buffer).digest('hex'); // checksum of the **meta-stripped** file
	const data = {
		camera: null,
		category: options.category?.toLowerCase(),
		createdAt: exif.Exif[piexif.ExifIFD.DateTimeOriginal],
		id: checksum,
		locationData: null,
		locationName: options.location,
		photographer: options.photographer,
	};

	if (exif['0th'][piexif.ImageIFD.Model] && android[data.camera]) data.camera = exif['0th'][piexif.ImageIFD.Model];
	else data.camera = exif['0th'][piexif.ImageIFD.Model];

	if (data.createdAt) {
		const regex = /(?<year>\d{4}):(?<month>\d{2}):(?<day>\d{2})\s(?<time>\d{2}:\d{2}:\d{2})/;
		const { groups } = regex.exec(data.createdAt);
		if (groups) data.createdAt = new Date(`${groups.year}-${groups.month}-${groups.day}T${groups.time}`);
	}

	const latitude = exif.GPS[piexif.GPSIFD.GPSLatitude];
	const latitudeRef = exif.GPS[piexif.GPSIFD.GPSLatitudeRef];
	const longitude = exif.GPS[piexif.GPSIFD.GPSLongitude];
	const longitudeRef = exif.GPS[piexif.GPSIFD.GPSLongitudeRef];

	if (latitude && longitude) {
		// convert & reduce precision
		const decimalLatitude = (latitudeRef === 'N' ? 1 : -1) * piexif.GPSHelper.dmsRationalToDeg(latitude).toFixed(1);
		const decimalLongitude = (longitudeRef === 'E' ? 1 : -1) * piexif.GPSHelper.dmsRationalToDeg(longitude).toFixed(1);
		data.locationData = `${decimalLatitude},${decimalLongitude}`;

		if (gpsCache.has(data.locationData)) {
			data.locationName = gpsCache.get(data.locationData);
		} else {
			spin.add('main.2', { text: `Fetching location of ${file}` });
			try {
				const res = await fetch(`https://proxy.muetab.com/weather/autolocation?lat=${decimalLatitude}&lon=${decimalLongitude}`);
				const json = await res.json();
				if (json[0]) data.locationName = `${json[0].name}, ${json[0].state}`;
				spin.succeed('main.2');
			} catch {
				spin.fail('main.2');
			}
		}
	}

	let v = 0;
	spin.add('main.1', { text: `Creating ${file} variants` });

	for await (const variant of variants) {
		v++;
		spin.update('main.1', { text: `Creating ${file} variants (${v}/${variants.length})` });
		const Key = `img/${variant.name}/${checksum}.${variant.format}`;
		spin.add('main.3', { text: `Generating ${Key}` });
		let image = sharp(buffer);
		if (variant.resolution) image = image.resize(variant.resolution[0], variant.resolution[1]);
		image = image.toFormat(variant.format, {
			effort: 6,
			quality: 85,
		});
		image = await image.toBuffer();
		spin.update('main.3', { text: `Uploading ${Key}` });
		try {
			await s3.upload(
				{
					ACL: 'public-read',
					Body: image,
					Bucket: process.env.S3_BUCKET,
					Key,
				},
			).promise();
			spin.succeed('main.3');
		} catch (error) {
			spin.fail('main.3');
			continue files; // don't add to database if a variant fails to upload
		}
	}

	try {
		spin.update('main.1', { text: `Upserting ${file} into database` });
		await supabase.from('images').upsert(data);
		spin.succeed('main.1');
		fsp.unlink(path);
	} catch (error) {
		spin.fail('main.1');
	}

	count++;
}

clearInterval(spinInterval);
spin.succeed('main', { text: `Importing images (${files.length}/${files.length}, 100.00%) ${ms(Date.now() - startTime)}` });
