// reads a DICOM file or directory and saves a chosen slice to a PNG image file
import { DicomImage, NativePixelDecoder, WindowLevel } from "dcmjs-imaging";
import { PNG } from "pngjs";
import { readFileSync, writeFileSync, statSync, readdirSync } from "fs";
import { join, extname } from "path";
import { Command } from "commander";

interface Dcm2PngOptions {
  input: string; // Can be file or directory
  output: string;
  slice?: number; // Optional slice number for multi-frame or directory
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
    .sort(); // Sort files for consistent ordering
}

function calculateOptimalWindowLevel(image: DicomImage): WindowLevel | null {
  try {
    // Render without window/level to analyze raw pixel values
    const testRender = image.render();
    
    // Convert to 16-bit values for analysis (assume rendered pixels are normalized)
    const pixels = new Uint8Array(testRender.pixels);
    
    // Convert back to approximate original values for better windowing
    // This is a simple approach - multiply by a factor to get reasonable dynamic range
    const pixelValues: number[] = [];
    
    for (let i = 0; i < pixels.length; i++) {
      const value = pixels[i];
      if (value !== undefined && value > 0) { // Skip zero values (background)
        // Scale up to approximate original DICOM values
        pixelValues.push(value * 16); // Scale factor for better dynamic range
      }
    }
    
    if (pixelValues.length > 1000) { // Ensure we have enough data points
      pixelValues.sort((a, b) => a - b);
      
      // Use percentile-based windowing for robust statistics
      const p2Index = Math.floor(pixelValues.length * 0.02);  // 2nd percentile
      const p98Index = Math.floor(pixelValues.length * 0.98); // 98th percentile
      
      const p2Val = pixelValues[p2Index]!;
      const p98Val = pixelValues[p98Index]!;
      
      // Use the middle 96% for window calculation (2nd to 98th percentile)
      const windowWidth = (p98Val - p2Val) * 1.2; // Add 20% margin
      const windowCenter = (p98Val + p2Val) / 2;
      
      console.log(`Calculated optimal window/level: center=${windowCenter.toFixed(1)}, width=${windowWidth.toFixed(1)} (from ${pixelValues.length} pixels)`);
      return new WindowLevel(windowWidth, windowCenter);
    }
    
    // Simple fallback if not enough pixels
    if (pixelValues.length > 0) {
      const minVal = Math.min(...pixelValues);
      const maxVal = Math.max(...pixelValues);
      const windowWidth = (maxVal - minVal) * 1.5;
      const windowCenter = (maxVal + minVal) / 2;
      
      console.log(`Simple window/level calculation: center=${windowCenter.toFixed(1)}, width=${windowWidth.toFixed(1)}`);
      return new WindowLevel(windowWidth, windowCenter);
    }
    
  } catch (error) {
    console.warn(`Could not calculate optimal window/level: ${error}`);
  }
  
  return null;
}

export const dcm2png = async (options: Dcm2PngOptions) => {
  // Initialize native decoders for compressed DICOM support
  await NativePixelDecoder.initializeAsync();

  let dicomFileBuffer: Buffer;
  let sourceDescription: string;

  // Check if input is a file or directory
  const inputStats = statSync(options.input);
  
  if (inputStats.isDirectory()) {
    // Handle directory input
    const dicomFiles = getDicomFilesFromDirectory(options.input);
    
    if (dicomFiles.length === 0) {
      throw new Error(`No DICOM files found in directory: ${options.input}`);
    }

    const sliceIndex = options.slice ?? 0;
    if (sliceIndex < 0 || sliceIndex >= dicomFiles.length) {
      throw new Error(`Slice ${sliceIndex} out of range. Directory contains ${dicomFiles.length} DICOM files (valid range: 0-${dicomFiles.length - 1})`);
    }

    const selectedFile = dicomFiles[sliceIndex]!;
    dicomFileBuffer = readFileSync(selectedFile);
    sourceDescription = `slice ${sliceIndex} from directory ${options.input} (file: ${selectedFile})`;
  } else {
    // Handle single file input
    dicomFileBuffer = readFileSync(options.input);
    sourceDescription = `file ${options.input}`;
  }

  // Create DicomImage from buffer
  const arrayBuffer = dicomFileBuffer.buffer.slice(
    dicomFileBuffer.byteOffset,
    dicomFileBuffer.byteOffset + dicomFileBuffer.byteLength
  ) as ArrayBuffer;
  
  const image = new DicomImage(arrayBuffer);

  // Calculate optimal window/level for better contrast
  const optimalWindowLevel = calculateOptimalWindowLevel(image);
  
  // Try to render with frame parameter if slice is specified
  let renderingResult;
  let frameIndex = options.slice ?? 0;
  
  const renderingOptions: any = {
    calculateHistograms: false,
    renderOverlays: true
  };
  
  if (optimalWindowLevel) {
    renderingOptions.windowLevel = optimalWindowLevel;
  }
  
  if (options.slice !== undefined && options.slice > 0) {
    try {
      // Try rendering with frame parameter for multi-frame images
      renderingOptions.frame = frameIndex;
      renderingResult = image.render(renderingOptions);
      sourceDescription += `, frame ${frameIndex}`;
    } catch (error) {
      // If frame rendering fails, fall back to default rendering
      console.warn(`Frame ${frameIndex} not available, using default rendering`);
      delete renderingOptions.frame;
      renderingResult = image.render(renderingOptions);
    }
  } else {
    // Default rendering for single frame or no slice specified
    if (frameIndex > 0) {
      renderingOptions.frame = frameIndex;
    }
    renderingResult = image.render(renderingOptions);
  }

  // Create PNG with rendered dimensions
  const png = new PNG({ 
    width: renderingResult.width, 
    height: renderingResult.height 
  });

  // Convert rendered pixels to PNG data
  const pixelData = new Uint8Array(renderingResult.pixels);
  
  // Handle different pixel formats
  if (pixelData.length === renderingResult.width * renderingResult.height) {
    // Grayscale data
    for (let i = 0; i < pixelData.length; i++) {
      const pngIdx = i * 4;
      const value = pixelData[i]!;
      
      png.data[pngIdx] = value;     // R
      png.data[pngIdx + 1] = value; // G  
      png.data[pngIdx + 2] = value; // B
      png.data[pngIdx + 3] = 255;   // A
    }
  } else if (pixelData.length === renderingResult.width * renderingResult.height * 3) {
    // RGB data
    for (let i = 0; i < pixelData.length; i += 3) {
      const pngIdx = (i / 3) * 4;
      
      png.data[pngIdx] = pixelData[i]!;     // R
      png.data[pngIdx + 1] = pixelData[i + 1]!; // G
      png.data[pngIdx + 2] = pixelData[i + 2]!; // B
      png.data[pngIdx + 3] = 255;           // A
    }
  } else if (pixelData.length === renderingResult.width * renderingResult.height * 4) {
    // RGBA data - copy directly
    for (let i = 0; i < pixelData.length; i++) {
      png.data[i] = pixelData[i]!;
    }
  } else {
    throw new Error(`Unsupported pixel format. Expected ${renderingResult.width * renderingResult.height} (grayscale), ${renderingResult.width * renderingResult.height * 3} (RGB), or ${renderingResult.width * renderingResult.height * 4} (RGBA) bytes, got ${pixelData.length}`);
  }

  // Write PNG file
  const buffer = PNG.sync.write(png);
  writeFileSync(options.output, buffer);

  console.log(`Saved ${sourceDescription} to ${options.output} (${renderingResult.width}x${renderingResult.height})`);
};

export const dcm2pngCLI = () => {
  return new Command("dcm2png")
    .description("Convert DICOM file or directory to PNG image")
    .requiredOption("-i, --input <path>", "Input DICOM file or directory path")
    .requiredOption("-o, --output <file>", "Output PNG file path")
    .option("-s, --slice <number>", "Slice/frame number (for multi-frame DICOM or directory)", "0")
    .action(async (options) => {
      try {
        await dcm2png({
          input: options.input,
          output: options.output,
          slice: parseInt(options.slice),
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