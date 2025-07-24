// converts DICOM files to NIFTI format using dcmjs and nifti-reader-js
import * as dcmjs from "dcmjs";
import * as nifti from "nifti-reader-js";
import { readFileSync, writeFileSync, statSync, readdirSync } from "fs";
import { join, extname, basename, dirname } from "path";
import { Command } from "commander";

interface Dcm2NiiOptions {
  input: string; // Can be single file, enhanced file, or directory
  output?: string; // Output directory or file path
}

interface DicomSeries {
  seriesInstanceUID: string;
  files: string[];
  seriesDescription?: string;
  seriesNumber?: number;
}

function isDicomFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return ext === '.dcm' || ext === '.dicom' || ext === '';
}

function getDicomFilesFromDirectory(dirPath: string): string[] {
  const files = readdirSync(dirPath);
  return files
    .map(file => join(dirPath, file))
    .filter(filePath => {
      try {
        const stats = statSync(filePath);
        return stats.isFile() && isDicomFile(filePath);
      } catch {
        return false;
      }
    })
    .sort();
}

function groupDicomFilesBySeries(dicomFiles: string[]): DicomSeries[] {
  const seriesMap = new Map<string, DicomSeries>();

  for (const filePath of dicomFiles) {
    try {
      const buffer = readFileSync(filePath);
      const arrayBuffer = buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength
      );
      
      const parsedData = dcmjs.data.DicomMessage.readFile(arrayBuffer);
      const dataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(parsedData.dict);
      
      const seriesInstanceUID = dataset.SeriesInstanceUID as string;
      if (!seriesInstanceUID) {
        console.warn(`No SeriesInstanceUID found in ${filePath}, skipping`);
        continue;
      }

      if (!seriesMap.has(seriesInstanceUID)) {
        seriesMap.set(seriesInstanceUID, {
          seriesInstanceUID,
          files: [],
          seriesDescription: dataset.SeriesDescription as string,
          seriesNumber: dataset.SeriesNumber as number,
        });
      }

      seriesMap.get(seriesInstanceUID)!.files.push(filePath);
    } catch (error) {
      console.warn(`Failed to read DICOM metadata from ${filePath}: ${error}`);
    }
  }

  // Sort files within each series by instance number or filename
  for (const series of seriesMap.values()) {
    series.files.sort((a, b) => {
      try {
        const bufferA = readFileSync(a);
        const bufferB = readFileSync(b);
        
        const arrayBufferA = bufferA.buffer.slice(bufferA.byteOffset, bufferA.byteOffset + bufferA.byteLength);
        const arrayBufferB = bufferB.buffer.slice(bufferB.byteOffset, bufferB.byteOffset + bufferB.byteLength);
        
        const datasetA = dcmjs.data.DicomMetaDictionary.naturalizeDataset(
          dcmjs.data.DicomMessage.readFile(arrayBufferA).dict
        );
        const datasetB = dcmjs.data.DicomMetaDictionary.naturalizeDataset(
          dcmjs.data.DicomMessage.readFile(arrayBufferB).dict
        );
        
        const instanceA = datasetA.InstanceNumber as number || 0;
        const instanceB = datasetB.InstanceNumber as number || 0;
        
        return instanceA - instanceB;
      } catch {
        // Fallback to filename sorting
        return basename(a).localeCompare(basename(b));
      }
    });
  }

  return Array.from(seriesMap.values());
}

function convertDicomSeriesToNifti(series: DicomSeries): ArrayBuffer {
  // Read all DICOM files in the series
  const dicomBuffers = series.files.map(filePath => {
    const buffer = readFileSync(filePath);
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  });

  // Use dcmjs to convert DICOM series to NIFTI
  const multiframe = dcmjs.normalizers.Normalizer.normalizeToDataset(dicomBuffers);
  
  // Convert to NIFTI format
  const niftiBuffer = dcmjs.adapters.Cornerstone3D.Cornerstone3D.generateNiftiFromDataset(
    multiframe,
    {
      useRealWorldValueMapping: true,
    }
  );

  return niftiBuffer;
}

function convertSingleDicomToNifti(filePath: string): ArrayBuffer {
  const buffer = readFileSync(filePath);
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  );

  // Check if it's an enhanced DICOM (multiframe)
  const parsedData = dcmjs.data.DicomMessage.readFile(arrayBuffer);
  const dataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(parsedData.dict);
  
  const numberOfFrames = dataset.NumberOfFrames as number;
  
  if (numberOfFrames && numberOfFrames > 1) {
    console.log(`Converting enhanced DICOM with ${numberOfFrames} frames`);
  }

  // Convert single file to NIFTI
  const multiframe = dcmjs.normalizers.Normalizer.normalizeToDataset([arrayBuffer]);
  const niftiBuffer = dcmjs.adapters.Cornerstone3D.Cornerstone3D.generateNiftiFromDataset(
    multiframe,
    {
      useRealWorldValueMapping: true,
    }
  );

  return niftiBuffer;
}

function generateOutputPath(
  inputPath: string,
  outputPath: string | undefined,
  series?: DicomSeries,
  seriesIndex?: number
): string {
  if (outputPath) {
    // If output is specified and it's a directory, generate filename
    try {
      const stats = statSync(outputPath);
      if (stats.isDirectory()) {
        if (series) {
          const seriesDesc = series.seriesDescription || `series_${series.seriesNumber || seriesIndex || 0}`;
          const cleanDesc = seriesDesc.replace(/[^a-zA-Z0-9_-]/g, '_');
          return join(outputPath, `${cleanDesc}.nii`);
        } else {
          const baseName = basename(inputPath, extname(inputPath));
          return join(outputPath, `${baseName}.nii`);
        }
      }
    } catch {
      // Output path doesn't exist, treat as file path
    }
    
    // If output path ends with .nii or .nii.gz, use as-is
    if (outputPath.endsWith('.nii') || outputPath.endsWith('.nii.gz')) {
      return outputPath;
    }
    
    // Otherwise append .nii
    return `${outputPath}.nii`;
  }

  // Generate output path based on input
  const inputDir = statSync(inputPath).isDirectory() ? inputPath : dirname(inputPath);
  
  if (series) {
    const seriesDesc = series.seriesDescription || `series_${series.seriesNumber || seriesIndex || 0}`;
    const cleanDesc = seriesDesc.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(inputDir, `${cleanDesc}.nii`);
  } else {
    const baseName = basename(inputPath, extname(inputPath));
    return join(inputDir, `${baseName}.nii`);
  }
}

export const dcm2nii = async (options: Dcm2NiiOptions) => {
  const inputStats = statSync(options.input);
  
  if (inputStats.isDirectory()) {
    // Handle directory input - group by series
    const dicomFiles = getDicomFilesFromDirectory(options.input);
    
    if (dicomFiles.length === 0) {
      throw new Error(`No DICOM files found in directory: ${options.input}`);
    }

    console.log(`Found ${dicomFiles.length} DICOM files in directory`);
    
    // Group files by series
    const seriesList = groupDicomFilesBySeries(dicomFiles);
    
    if (seriesList.length === 0) {
      throw new Error('No valid DICOM series found');
    }

    console.log(`Found ${seriesList.length} DICOM series`);
    
    // Convert each series to NIFTI
    const outputPaths: string[] = [];
    for (let i = 0; i < seriesList.length; i++) {
      const series = seriesList[i]!;
      console.log(`Converting series ${i + 1}/${seriesList.length}: ${series.seriesDescription || series.seriesInstanceUID} (${series.files.length} files)`);
      
      try {
        const niftiBuffer = convertDicomSeriesToNifti(series);
        const outputPath = generateOutputPath(options.input, options.output, series, i);
        
        writeFileSync(outputPath, Buffer.from(niftiBuffer));
        outputPaths.push(outputPath);
        console.log(`Saved: ${outputPath}`);
      } catch (error) {
        console.error(`Failed to convert series ${series.seriesInstanceUID}: ${error}`);
      }
    }
    
    if (outputPaths.length === 0) {
      throw new Error('Failed to convert any DICOM series to NIFTI');
    }
    
    console.log(`Successfully converted ${outputPaths.length} series to NIFTI format`);
    
  } else {
    // Handle single file input
    console.log(`Converting single DICOM file: ${options.input}`);
    
    try {
      const niftiBuffer = convertSingleDicomToNifti(options.input);
      const outputPath = generateOutputPath(options.input, options.output);
      
      writeFileSync(outputPath, Buffer.from(niftiBuffer));
      console.log(`Saved: ${outputPath}`);
    } catch (error) {
      throw new Error(`Failed to convert DICOM file to NIFTI: ${error}`);
    }
  }
};

export const dcm2niiCLI = () => {
  return new Command("dcm2nii")
    .description("Convert DICOM files to NIFTI format")
    .requiredOption("-i, --input <path>", "Input DICOM file or directory path")
    .option("-o, --output <path>", "Output NIFTI file or directory path (optional)")
    .action(async (options) => {
      try {
        await dcm2nii({
          input: options.input,
          output: options.output,
        });
      } catch (error) {
        console.error(
          "Error:",
          error instanceof Error ? error.message : String(error)
        );
        process.exit(1);
      }
    });
};