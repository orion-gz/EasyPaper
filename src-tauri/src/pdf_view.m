#import <PDFKit/PDFKit.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#include <stdbool.h>

static char viewKey;

bool ep_pdf_update(WKWebView *web, const unsigned char *bytes, size_t count,
                   double x, double y, double width, double height, bool close) {
    PDFView *view = objc_getAssociatedObject(web, &viewKey);
    if (close) {
        [view removeFromSuperview];
        objc_setAssociatedObject(web, &viewKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        return true;
    }
    if (count) {
        PDFDocument *document = [[PDFDocument alloc] initWithData:[NSData dataWithBytes:bytes length:count]];
        if (!document || document.isLocked) return false;
        if (!view) {
            view = [[PDFView alloc] initWithFrame:NSZeroRect];
            [web addSubview:view];
            objc_setAssociatedObject(web, &viewKey, view, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        }
        view.displayMode = kPDFDisplaySinglePageContinuous;
        view.document = document;
    }
    if (!view) return false;
    view.frame = NSMakeRect(x, web.isFlipped ? y : NSHeight(web.bounds) - y - height, width, height);
    if (count) view.autoScales = YES;
    return true;
}
