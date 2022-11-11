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
import piexif from 'piexifjs';
import sharp from 'sharp';
import prettyBytes from 'pretty-bytes';

config();

console.log(gradient('#ffb032', '#dd3b67').multiline(figlet.textSync('Mue Importer', {})));

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

program
	.option('-c, --category <name>', 'image category')
	.option('-l, --location <name>', 'fallback location name (if not in EXIF)')
	.option('-p, --photographer <name>', 'photographer name');
program.parse(process.argv);
const options = program.opts();

let { data: categories } = await supabase.rpc('get_image_categories');
categories = categories.map(row => row.name);

options.category = options.category?.toLowerCase() || undefined;
if (!options.category) {
	console.log(colours.yellowBright('Warning: no category; all images must have a category to be selected; only use an undefined category if you are updating existing images'));
	console.log(colours.blueBright(`Existing categories: ${categories.join(', ')}`));
} else if (!categories.includes(options.category)) {
	console.log(colours.yellowBright(`Warning: ${options.category} is not an existing category (but will be created if you continue)`));
	console.log(colours.blueBright(`Existing categories: ${categories.join(', ')}`));
} else {
	console.log(colours.greenBright(`Category: ${options.category}`));
}

if (!options.location) console.log(colours.yellowBright('Warning: no fallback location'));
else console.log(colours.greenBright(`Fallback location: ${options.location}`));

if (!options.photographer) {
	console.log(colours.redBright('Error: no photographer'));
	process.exit(1);
} else {
	console.log(colours.greenBright(`Photographer: ${options.photographer}`));
}

const resolutions = {
	hd: [null, 720],
	fhd: [null, 1080], // eslint-disable-line sort-keys
	qhd: [null, 1440],
	original: null, // eslint-disable-line sort-keys
};
const formats = ['avif', 'webp'];
const rc = Object.keys(resolutions).length;
const fc = formats.length;

console.log(colours.blueBright(`Variants: ${rc * fc} (${rc} resolutions, ${fc} formats)`));

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
	spin.add('files', { text: `Reading ${file}` });
	const path = resolve('import', file);
	let buffer = await fsp.readFile(path);
	const binary = buffer.toString('binary');
	const exif = piexif.load(binary);
	buffer = Buffer.from(piexif.remove(binary), 'binary'); // same as `buffer` but without metadata
	const checksum = createHash('md5').update(buffer).digest('hex'); // checksum of the **meta-stripped** file
	const { dominant } = await sharp(buffer).stats();
	const data = {
		camera: null,
		category: options.category?.toLowerCase(),
		colour: '#' + Object.values(dominant).map(n => ('0' + parseInt(n).toString(16)).slice(-2)).join(''),
		created_at: exif.Exif[piexif.ExifIFD.DateTimeOriginal],
		id: checksum,
		location_data: null,
		location_name: options.location,
		original_file_name: file,
		photographer: options.photographer,
		version: Math.floor(Date.now() / 1000),
	};

	if (exif['0th'][piexif.ImageIFD.Model] && android[data.camera]) data.camera = exif['0th'][piexif.ImageIFD.Model];
	else data.camera = exif['0th'][piexif.ImageIFD.Model];

	if (data.created_at) {
		const regex = /(?<year>\d{4}):(?<month>\d{2}):(?<day>\d{2})\s(?<time>\d{2}:\d{2}:\d{2})/;
		const { groups } = regex.exec(data.created_at);
		if (groups) data.created_at = new Date(`${groups.year}-${groups.month}-${groups.day}T${groups.time}`);
	}

	const latitude = exif.GPS[piexif.GPSIFD.GPSLatitude];
	const latitudeRef = exif.GPS[piexif.GPSIFD.GPSLatitudeRef];
	const longitude = exif.GPS[piexif.GPSIFD.GPSLongitude];
	const longitudeRef = exif.GPS[piexif.GPSIFD.GPSLongitudeRef];

	if (latitude && longitude) {
		// convert & reduce precision
		const decimalLatitude = (latitudeRef === 'N' ? 1 : -1) * piexif.GPSHelper.dmsRationalToDeg(latitude).toFixed(1);
		const decimalLongitude = (longitudeRef === 'E' ? 1 : -1) * piexif.GPSHelper.dmsRationalToDeg(longitude).toFixed(1);
		data.location_data = `${decimalLatitude},${decimalLongitude}`;

		if (gpsCache.has(data.location_data)) {
			data.location_name = gpsCache.get(data.location_data);
		} else {
			spin.add('file', { text: `Fetching location of ${file}` });
			try {
				const res = await fetch(`https://api.muetab.com/v2/gps?lat=${decimalLatitude}&lon=${decimalLongitude}`);
				const json = await res.json();
				if (json[0]) data.location_name = `${json[0].name}, ${json[0].state}`;
				spin.succeed('file');
			} catch {
				spin.fail('file');
			}
		}
	}

	spin.update('files', { text: `Processing ${file}` });
	spin.add('file', { text: `Creating ${file} variants` });

	const variants = {};

	for (const format of formats) {
		spin.update('file', { text: `Encoding ${file} to ${format.toUpperCase()}` });
		const encoded = await sharp(buffer).toFormat(format).toBuffer();
		for (const [name, dimensions] of Object.entries(resolutions)) {
			spin.update('file', { text: `Resizing ${file} (${format.toUpperCase() }) to ${name.toUpperCase()}` });
			let buffer = encoded;
			if (dimensions) buffer = await sharp(encoded).resize(dimensions[0], dimensions[1]).toBuffer();
			variants[`img/${name}/${checksum}.${format}`] = buffer;
		}
	}

	for (const variant in variants) {
		spin.update('file', { text: `Uploading ${variant} (${prettyBytes(Buffer.byteLength(variants[variant]))})` });
		try {
			await s3.upload(
				{
					ACL: 'public-read',
					Body: variants[variant],
					Bucket: process.env.S3_BUCKET,
					CacheControl: 'public, max-age=604800, s-max-age=31536000, stale-while-revalidate=86400, immutable',
					ContentMD5: createHash('md5').update(variants[variant]).digest('base64'),
					ContentType: 'image/' + variant.split('.').pop(),
					Key: variant,
				},
			).promise();
		} catch (error) {
			spin.fail('file', { text: spin.pick('file').text + ':\n' + error });
			continue files; // don't add to database if a variant fails to upload
		}
	}

	try {
		spin.update('file', { text: `Upserting ${file} into database` });
		const { error } = await supabase.from('images').upsert(data);
		if (error) throw error;
		spin.succeed('file');
		fsp.unlink(path);
		spin.succeed('files');
	} catch (error) {
		spin.fail('file', { text: spin.pick('file').text + ':\n' + error });
	}

	count++;
}

clearInterval(spinInterval);
spin.succeed('main', { text: `Importing images (${files.length}/${files.length}, 100.00%) ${ms(Date.now() - startTime)}` });
spin.stopAll();
