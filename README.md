# egami

⚠️ **Work in Progress** - This package is currently under active development. Do not use it if you are reading this warning. 

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run src/index.ts
```

## Building

To compile to a single executable:

```bash
bun build --compile src/index.ts --outfile egami
```

This creates a standalone `egami` executable that can be run without Bun installed.

This project was created using `bun init` in bun v1.2.19. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Commands

<details>
<summary><strong>nii2png</strong> - Convert NIFTI slice to PNG image</summary>

### Description
Converts a single slice from a NIFTI (.nii/.nii.gz) file to a PNG image. Supports both grayscale and RGB24 NIFTI files and allows extraction along different anatomical planes.

### Usage
```bash
egami nii2png -i <input.nii> -o <output.png> [options]
```

### Options
- `-i, --input <file>` - Input NIFTI file path (required)
- `-o, --output <file>` - Output PNG file path (required)  
- `-d, --dim <dimension>` - Dimension to slice along (default: "z")
  - `x` or `1` - Sagittal plane
  - `y` or `2` - Coronal plane
  - `z` or `3` - Axial plane
- `-s, --slice <number>` - Slice number to extract (default: "0")

### Examples
```bash
# Extract middle axial slice from brain.nii.gz
egami nii2png -i brain.nii.gz -o brain_axial.png -d z -s 50

# Extract sagittal slice
egami nii2png -i brain.nii -o brain_sagittal.png -d x -s 25

# Extract coronal slice (using numeric dimension)
egami nii2png -i brain.nii -o brain_coronal.png -d 2 -s 30
```

### Supported Data Types
- UINT8, INT16, FLOAT32, FLOAT64
- RGB24 (automatically converted with proper color handling)

</details>

<details>
<summary><strong>dcm2png</strong> - Convert DICOM file or directory to PNG image</summary>

### Description
Converts a DICOM file or directory to a PNG image. Supports both single DICOM files and directories containing multiple DICOM files. For multi-frame DICOM files or directories, allows selection of specific slices/frames.

### Usage
```bash
egami dcm2png -i <input> -o <output.png> [options]
```

### Options
- `-i, --input <path>` - Input DICOM file or directory path (required)
- `-o, --output <file>` - Output PNG file path (required)
- `-s, --slice <number>` - Slice/frame number for multi-frame DICOM or directory (default: "0")

### Examples
```bash
# Convert single DICOM file to PNG
egami dcm2png -i scan.dcm -o scan.png

# Convert specific slice from multi-frame DICOM
egami dcm2png -i multiframe.dcm -o slice5.png -s 5

# Convert specific file from DICOM directory (slice 0 = first file)
egami dcm2png -i /path/to/dicom/series -o slice0.png -s 0

# Convert 10th file from DICOM directory
egami dcm2png -i /path/to/dicom/series -o slice10.png -s 10
```

### Features
- Automatic optimal window/level calculation for better contrast
- Support for compressed DICOM files
- Handles grayscale, RGB, and RGBA pixel formats
- Directory support with automatic DICOM file detection and sorting

</details>

<details>
<summary><strong>dcm2nii</strong> - Convert DICOM files to NIFTI format</summary>

### Description
Converts DICOM files to NIFTI (.nii) format. Supports single DICOM files, enhanced DICOM files with multiple frames, and directories containing DICOM series. Automatically groups files by series and handles both 3D and 4D datasets.

### Usage
```bash
egami dcm2nii -i <input> [options]
```

### Options
- `-i, --input <path>` - Input DICOM file or directory path (required)
- `-o, --output <path>` - Output NIFTI file or directory path (optional)

### Examples
```bash
# Convert single DICOM file to NIFTI
egami dcm2nii -i scan.dcm -o scan.nii

# Convert enhanced DICOM with multiple frames
egami dcm2nii -i multiframe.dcm -o volume.nii

# Convert entire DICOM directory (groups by series)
egami dcm2nii -i /path/to/dicom/series

# Convert directory with custom output location
egami dcm2nii -i /path/to/dicom/series -o /output/directory
```

### Features
- Automatic series detection and grouping by SeriesInstanceUID
- Support for 3D and 4D NIFTI output (including time-series DWI data)
- Handles enhanced DICOM files with multiple frames per file
- Preserves spatial resolution and orientation information
- Automatic filename generation based on series description
- Robust pixel data handling for various DICOM formats

</details>
