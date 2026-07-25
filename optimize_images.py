# optimize_images.py - Resizing and WebP compression pipeline for Shweta Studio
import os
import glob
from PIL import Image

def optimize_image(img_path):
    print(f"Optimizing: {img_path}...")
    try:
        # Open source image
        with Image.open(img_path) as im:
            # Convert to RGB (required for WebP output of RGBA/CMYK images)
            if im.mode != "RGB":
                im = im.convert("RGB")
            
            base_dir = os.path.dirname(img_path)
            base_name = os.path.splitext(os.path.basename(img_path))[0]
            
            # Target sizes
            sizes = {
                'large': 1200,
                'medium': 800,
                'thumb': 400
            }
            
            for suffix, max_size in sizes.items():
                target_path = os.path.join(base_dir, f"{base_name}_{suffix}.webp")
                
                # If optimized file already exists and is newer than source, skip it to save time
                if os.path.exists(target_path) and os.path.getmtime(target_path) > os.path.getmtime(img_path):
                    continue
                
                # Calculate new aspect-ratio-scaled dimensions
                width, height = im.size
                if width > max_size or height > max_size:
                    if width > height:
                        new_w = max_size
                        new_h = int(height * (max_size / width))
                    else:
                        new_h = max_size
                        new_w = int(width * (max_size / height))
                    
                    resized_im = im.resize((new_w, new_h), Image.Resampling.LANCZOS)
                else:
                    resized_im = im
                
                # Save as WebP
                # quality=85 is standard, thumb can be 80, large can be 85
                quality = 80 if suffix == 'thumb' else 85
                resized_im.save(target_path, "WEBP", quality=quality)
                
            print(f"  Generated WebP variants for: {base_name}")
    except Exception as e:
        print(f"  [ERROR] Failed to optimize {img_path}: {e}")

def main():
    # Scan all work directory recursively for image formats
    extensions = ['*.jpg', '*.jpeg', '*.png', '*.JPG', '*.JPEG', '*.PNG']
    images_found = []
    
    for ext in extensions:
        images_found.extend(glob.glob(f"all work/**/{ext}", recursive=True))
        
    print(f"Found {len(images_found)} source artwork images under 'all work/'. Starting pipeline...")
    
    for img_path in images_found:
        optimize_image(img_path)
        
    print("Optimization pipeline completed successfully!")

if __name__ == "__main__":
    main()
