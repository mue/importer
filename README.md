# importer

> **Note**
>
> This is a tool for use by the Mue team.
> If you want to add your photos to Mue, please [contact us](https://muetab.com/contact).

## Installation

Clone the repository and run `pnpm i`.

### Environment

```
S3_ACCESS=
S3_BUCKET=
S3_ENDPOINT=
S3_SECRET=
SUPABASE_URL=
SUPABASE_SECRET=
```

## Usage

```
Usage: importer [options]

Options:
  -c, --category <name>      image category (default: "outdoors")
  -l, --location <name>      fallback location name (if not in EXIF)
  -p, --photographer <name>  photographer name
  -h, --help                 display help for command
```

> **Note**
>
> If you're relying on the location name being determined from EXIF GPS coordinates,
> check the results in database when the images have been uploaded.


You must sort the images you want to import into photo sets.
You can only upload one photo set at a time.

A photo set is a group of photos:

- taken by the same photographer
- of the same category
- taken in roughly the same area (same country at least)

### Photo requirements

Photos must:

- look good
- be landscape orientation
- be at least 1080p
- not be very blurry or out of focus 
- not be very similar to an existing image
- not be of people

> **Warning**
>
> The files in the import directory will be deleted

### Example

```
node . -p "Isaac Saunders" -l "England"
```
