#import <PDFKit/PDFKit.h>
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

static NSMutableDictionary<NSString *, PDFDocument *> *g_documents = nil;
static NSLock *g_lock = nil;

static void ensure_state(void) {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        g_lock = [[NSLock alloc] init];
        g_documents = [[NSMutableDictionary alloc] init];
    });
}

bool ep_pdf_load_document(const char *doc_key, const unsigned char *bytes, size_t count) {
    if (!doc_key) return false;
    ensure_state();
    NSString *key = [NSString stringWithUTF8String:doc_key];
    [g_lock lock];
    if (count == 0 || !bytes) {
        [g_documents removeObjectForKey:key];
        [g_lock unlock];
        return true;
    }
    if (g_documents[key] != nil) {
        [g_lock unlock];
        return true;
    }
    NSData *data = [NSData dataWithBytes:bytes length:count];
    PDFDocument *doc = [[PDFDocument alloc] initWithData:data];
    if (!doc || doc.isLocked) {
        [g_lock unlock];
        return false;
    }
    if (g_documents.count >= 12) {
        [g_documents removeAllObjects];
    }
    g_documents[key] = doc;
    [g_lock unlock];
    return true;
}

unsigned char *ep_pdf_render_page(const char *doc_key, size_t page_number,
                                  size_t pixel_width, size_t pixel_height,
                                  bool dark_mode, size_t *out_len) {
    if (out_len) *out_len = 0;
    if (!doc_key || page_number < 1 || pixel_width < 1 || pixel_height < 1) return NULL;
    ensure_state();
    NSString *key = [NSString stringWithUTF8String:doc_key];
    [g_lock lock];
    PDFDocument *doc = g_documents[key];
    if (!doc || page_number > doc.pageCount) {
        [g_lock unlock];
        return NULL;
    }
    PDFPage *page = [doc pageAtIndex:(page_number - 1)];
    if (!page) {
        [g_lock unlock];
        return NULL;
    }

    @autoreleasepool {
        NSRect mediaBox = [page boundsForBox:kPDFDisplayBoxMediaBox];
        NSInteger rotation = page.rotation;
        CGFloat pageW = mediaBox.size.width;
        CGFloat pageH = mediaBox.size.height;
        if (rotation == 90 || rotation == 270) {
            CGFloat tmp = pageW;
            pageW = pageH;
            pageH = tmp;
        }
        if (pageW <= 0 || pageH <= 0) {
            [g_lock unlock];
            return NULL;
        }

        CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
        CGContextRef ctx = CGBitmapContextCreate(
            NULL,
            pixel_width,
            pixel_height,
            8,
            pixel_width * 4,
            colorSpace,
            (CGBitmapInfo)kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big
        );
        CGColorSpaceRelease(colorSpace);
        if (!ctx) {
            [g_lock unlock];
            return NULL;
        }

        CGContextSetRGBFillColor(ctx, 1.0, 1.0, 1.0, 1.0);
        CGContextFillRect(ctx, CGRectMake(0, 0, pixel_width, pixel_height));

        CGContextSaveGState(ctx);
        CGContextSetInterpolationQuality(ctx, kCGInterpolationHigh);
        CGContextSetShouldAntialias(ctx, true);
        CGContextSetShouldSmoothFonts(ctx, true);
        CGContextScaleCTM(ctx, (CGFloat)pixel_width / pageW, (CGFloat)pixel_height / pageH);
        [page drawWithBox:kPDFDisplayBoxMediaBox toContext:ctx];
        CGContextRestoreGState(ctx);
        [g_lock unlock];

        if (dark_mode) {
            unsigned char *pixels = (unsigned char *)CGBitmapContextGetData(ctx);
            if (pixels) {
                size_t total_pixels = pixel_width * pixel_height;
                for (size_t i = 0; i < total_pixels; i++) {
                    unsigned char *px = pixels + (i * 4);
                    // Eye-comfort dark mode inversion matching invert(0.93) hue-rotate(180deg)
                    // without requiring WebKit real-time CSS filter shaders during scrolling.
                    double r = px[0] / 255.0;
                    double g = px[1] / 255.0;
                    double b = px[2] / 255.0;
                    // Invert with 0.93 strength (white -> #121212, black -> #ededed)
                    double ir = 0.93 * (1.0 - r) + 0.035;
                    double ig = 0.93 * (1.0 - g) + 0.035;
                    double ib = 0.93 * (1.0 - b) + 0.035;
                    // Approximate 180deg hue rotation around luminance to preserve color hues
                    double luma = 0.2126 * ir + 0.7152 * ig + 0.0722 * ib;
                    double hr = 2.0 * luma - ir;
                    double hg = 2.0 * luma - ig;
                    double hb = 2.0 * luma - ib;
                    if (hr < 0.0) hr = 0.0; else if (hr > 1.0) hr = 1.0;
                    if (hg < 0.0) hg = 0.0; else if (hg > 1.0) hg = 1.0;
                    if (hb < 0.0) hb = 0.0; else if (hb > 1.0) hb = 1.0;
                    px[0] = (unsigned char)(hr * 255.0 + 0.5);
                    px[1] = (unsigned char)(hg * 255.0 + 0.5);
                    px[2] = (unsigned char)(hb * 255.0 + 0.5);
                }
            }
        }

        CGImageRef cgImage = CGBitmapContextCreateImage(ctx);
        CGContextRelease(ctx);
        if (!cgImage) return NULL;

        NSMutableData *pngData = [NSMutableData data];
        CGImageDestinationRef dest = CGImageDestinationCreateWithData(
            (__bridge CFMutableDataRef)pngData,
            CFSTR("public.png"),
            1,
            NULL
        );
        if (!dest) {
            CGImageRelease(cgImage);
            return NULL;
        }
        CGImageDestinationAddImage(dest, cgImage, NULL);
        bool finalized = CGImageDestinationFinalize(dest);
        CFRelease(dest);
        CGImageRelease(cgImage);
        if (!finalized || pngData.length == 0) return NULL;

        unsigned char *buffer = (unsigned char *)malloc(pngData.length);
        if (!buffer) return NULL;
        memcpy(buffer, pngData.bytes, pngData.length);
        if (out_len) *out_len = pngData.length;
        return buffer;
    }
}

void ep_pdf_free_buffer(unsigned char *buffer) {
    if (buffer) free(buffer);
}


