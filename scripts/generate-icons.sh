#!/bin/bash

# =============================================================================
# Halo App Icon Generator
# Generates platform-specific icons from a source SVG
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RESOURCES_DIR="$PROJECT_ROOT/resources"
SOURCE_SVG="$RESOURCES_DIR/icon.svg"
ICONSET_DIR="$RESOURCES_DIR/icon.iconset"

echo "🎨 Halo Icon Generator"
echo "======================"
echo ""

# Check for required tools
check_tools() {
    local missing=()

    if ! command -v convert &> /dev/null; then
        missing+=("ImageMagick (convert)")
    fi

    if [[ "$OSTYPE" == "darwin"* ]]; then
        if ! command -v iconutil &> /dev/null; then
            missing+=("iconutil")
        fi
    fi

    if [ ${#missing[@]} -ne 0 ]; then
        echo "❌ Missing required tools:"
        for tool in "${missing[@]}"; do
            echo "   - $tool"
        done
        echo ""
        echo "Install ImageMagick: brew install imagemagick"
        exit 1
    fi

    echo "✅ All required tools available"
}

# Generate PNG from SVG at specific size
generate_png() {
    local size=$1
    local output=$2
    local temp_dir=$(mktemp -d)

    # Use qlmanage (macOS Quick Look) for proper SVG gradient rendering
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # Generate at larger size for quality
        qlmanage -t -s 1024 -o "$temp_dir" "$SOURCE_SVG" 2>/dev/null
        if [ -f "$temp_dir/icon.svg.png" ]; then
            # Remove white background and resize
            magick "$temp_dir/icon.svg.png" -fuzz 1% -transparent white -resize "${size}x${size}" "$output" 2>/dev/null || \
            convert "$temp_dir/icon.svg.png" -fuzz 1% -transparent white -resize "${size}x${size}" "$output" 2>/dev/null
            rm -rf "$temp_dir"
            echo "   Generated: $output (${size}x${size})"
            return
        fi
    fi

    # Fallback to ImageMagick
    magick -background none -density 300 "$SOURCE_SVG" -resize "${size}x${size}" -gravity center -extent "${size}x${size}" "$output" 2>/dev/null || \
    convert -background none -density 300 "$SOURCE_SVG" -resize "${size}x${size}" -gravity center -extent "${size}x${size}" "$output" 2>/dev/null
    rm -rf "$temp_dir"
    echo "   Generated: $output (${size}x${size})"
}

# Generate macOS iconset
generate_macos_iconset() {
    echo ""
    echo "📱 Generating macOS iconset..."

    rm -rf "$ICONSET_DIR"
    mkdir -p "$ICONSET_DIR"

    # Required sizes for macOS iconset
    local sizes=(16 32 64 128 256 512 1024)

    for size in "${sizes[@]}"; do
        generate_png $size "$ICONSET_DIR/icon_${size}x${size}.png"

        # Retina versions (except for 1024)
        if [ $size -lt 512 ]; then
            local retina_size=$((size * 2))
            generate_png $retina_size "$ICONSET_DIR/icon_${size}x${size}@2x.png"
        fi
    done

    # Special case: 512@2x = 1024
    cp "$ICONSET_DIR/icon_1024x1024.png" "$ICONSET_DIR/icon_512x512@2x.png"

    echo ""
    echo "🍎 Creating macOS .icns file..."
    iconutil -c icns "$ICONSET_DIR" -o "$RESOURCES_DIR/icon.icns"
    echo "   Generated: $RESOURCES_DIR/icon.icns"

    # Cleanup iconset folder (optional, keep for reference)
    # rm -rf "$ICONSET_DIR"
}

# Generate Windows ICO
generate_windows_ico() {
    echo ""
    echo "🪟 Generating Windows .ico file..."

    local temp_dir="$RESOURCES_DIR/temp_ico"
    mkdir -p "$temp_dir"

    # Windows ICO sizes
    local sizes=(16 24 32 48 64 128 256)
    local png_files=()

    for size in "${sizes[@]}"; do
        local png_file="$temp_dir/icon_${size}.png"
        generate_png $size "$png_file"
        png_files+=("$png_file")
    done

    # Create ICO with all sizes
    convert "${png_files[@]}" "$RESOURCES_DIR/icon.ico"
    echo "   Generated: $RESOURCES_DIR/icon.ico"

    # Cleanup
    rm -rf "$temp_dir"
}

# Generate Linux PNGs
generate_linux_pngs() {
    echo ""
    echo "🐧 Generating Linux PNG files..."

    local linux_dir="$RESOURCES_DIR/linux"
    mkdir -p "$linux_dir"

    # Common Linux icon sizes
    local sizes=(16 24 32 48 64 128 256 512)

    for size in "${sizes[@]}"; do
        generate_png $size "$linux_dir/${size}x${size}.png"
    done

    # Also create a main icon.png at 512x512
    cp "$linux_dir/512x512.png" "$RESOURCES_DIR/icon.png"
    echo "   Generated: $RESOURCES_DIR/icon.png (512x512)"
}

# Generate tray icons (for system tray)
generate_tray_icons() {
    echo ""
    echo "🔔 Generating tray icons..."

    local tray_dir="$RESOURCES_DIR/tray"
    mkdir -p "$tray_dir"

    # Tray icon sizes
    generate_png 16 "$tray_dir/tray-16.png"
    generate_png 16 "$tray_dir/tray-16@2x.png"  # Actually 32px for retina
    generate_png 32 "$tray_dir/tray-16@2x.png"
    generate_png 24 "$tray_dir/tray-24.png"
    generate_png 48 "$tray_dir/tray-24@2x.png"

    # Template icons for macOS (white silhouette)
    convert -background none -density 400 "$SOURCE_SVG" -resize "22x22" \
        -colorspace gray -fill white -colorize 100% \
        "$tray_dir/trayTemplate.png"
    convert -background none -density 400 "$SOURCE_SVG" -resize "44x44" \
        -colorspace gray -fill white -colorize 100% \
        "$tray_dir/trayTemplate@2x.png"

    echo "   Generated tray icons in $tray_dir"
}

# Main execution
main() {
    echo "Source: $SOURCE_SVG"
    echo "Output: $RESOURCES_DIR"
    echo ""

    if [ ! -f "$SOURCE_SVG" ]; then
        echo "❌ Source SVG not found: $SOURCE_SVG"
        exit 1
    fi

    check_tools

    generate_macos_iconset
    generate_windows_ico
    generate_linux_pngs
    generate_tray_icons

    echo ""
    echo "============================================"
    echo "✅ All icons generated successfully!"
    echo ""
    echo "Generated files:"
    echo "  - icon.icns     (macOS app icon)"
    echo "  - icon.ico      (Windows app icon)"
    echo "  - icon.png      (Linux/general use)"
    echo "  - linux/        (Linux multi-size)"
    echo "  - tray/         (System tray icons)"
    echo "  - icon.iconset/ (macOS iconset source)"
    echo ""
    echo "To rebuild icons, place your new icon.svg in"
    echo "resources/ and run this script again."
    echo "============================================"
}

main "$@"
