#import <PDFKit/PDFKit.h>
#import <WebKit/WebKit.h>
#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>
#include <stdbool.h>
#include <stdlib.h>

static char viewKey;
static char observerKey;

@interface EPNativePdfView : PDFView
@property (nonatomic, weak) WKWebView *hostWebView;
@property (nonatomic, copy) NSArray<NSValue *> *interactiveWebRects;
- (void)updateOverlayCutoutMask;
@end

@implementation EPNativePdfView

- (NSView *)hitTest:(NSPoint)point {
    // point is in superview (WKWebView) coordinate system.
    if (self.hidden || !NSPointInRect(point, self.frame)) {
        return nil;
    }
    WKWebView *web = self.hostWebView;
    if (web && self.interactiveWebRects.count > 0) {
        double topLeftX = point.x;
        double topLeftY = web.isFlipped ? point.y : (NSHeight(web.bounds) - point.y);
        NSPoint webPt = NSMakePoint(topLeftX, topLeftY);
        for (NSValue *val in self.interactiveWebRects) {
            if (NSPointInRect(webPt, val.rectValue)) {
                // Pass clicks/drags through to WKWebView for floating toolbars, selection menus,
                // memo alignment buttons, floating memo cards, and modals.
                return nil;
            }
        }
    }
    return [super hitTest:point];
}

- (void)setFrame:(NSRect)frame {
    [super setFrame:frame];
    [self updateOverlayCutoutMask];
}

- (void)updateOverlayCutoutMask {
    if (!self.layer) {
        self.wantsLayer = YES;
    }
    WKWebView *web = self.hostWebView;
    if (!web || self.interactiveWebRects.count == 0 || NSIsEmptyRect(self.bounds)) {
        self.layer.mask = nil;
        return;
    }

    CGMutablePathRef path = CGPathCreateMutable();
    CGPathAddRect(path, NULL, NSRectToCGRect(self.bounds));
    BOOL hasCutout = NO;

    for (NSValue *val in self.interactiveWebRects) {
        NSRect topLeftRect = val.rectValue;
        // Convert top-left web coordinates to WKWebView coordinates
        double wy = web.isFlipped
            ? topLeftRect.origin.y
            : (NSHeight(web.bounds) - topLeftRect.origin.y - topLeftRect.size.height);
        NSRect webRect = NSMakeRect(topLeftRect.origin.x, wy, topLeftRect.size.width, topLeftRect.size.height);
        NSRect localRect = [self convertRect:webRect fromView:web];
        NSRect clipped = NSIntersectionRect(localRect, self.bounds);
        if (!NSIsEmptyRect(clipped) && clipped.size.width > 1.0 && clipped.size.height > 1.0) {
            CGPathAddRect(path, NULL, NSRectToCGRect(clipped));
            hasCutout = YES;
        }
    }

    if (!hasCutout) {
        CGPathRelease(path);
        self.layer.mask = nil;
        return;
    }

    CAShapeLayer *maskLayer = [CAShapeLayer layer];
    maskLayer.frame = NSRectToCGRect(self.bounds);
    maskLayer.fillRule = kCAFillRuleEvenOdd;
    maskLayer.path = path;
    CGPathRelease(path);
    self.layer.mask = maskLayer;
}

@end

@interface EPNativePdfObserver : NSObject
@property (nonatomic, weak) WKWebView *webView;
@property (nonatomic, weak) EPNativePdfView *pdfView;
@property (nonatomic, weak) NSScrollView *scrollView;
@property (nonatomic, assign) NSInteger lastReportedPage;
@property (nonatomic, assign) BOOL suppressScrollReport;
@end

@implementation EPNativePdfObserver

- (void)emitEvent:(NSDictionary *)payload {
    WKWebView *web = self.webView;
    if (!web || !payload) return;
    NSError *error = nil;
    NSData *jsonData = [NSJSONSerialization dataWithJSONObject:payload options:0 error:&error];
    if (!jsonData || error) return;
    NSString *json = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
    if (!json) return;
    // Dispatch to both top window and the active workspace document iframe so events
    // always reach the document runtime regardless of iframe isolation.
    NSString *js = [NSString stringWithFormat:
        @"(function(ev){"
         "  if (window.__easypaperNativePdfDispatch) window.__easypaperNativePdfDispatch(ev);"
         "  var frames = document.querySelectorAll('.workspace-document-frame:not([hidden])');"
         "  for (var i = 0; i < frames.length; i++) {"
         "    try {"
         "      var cw = frames[i].contentWindow;"
         "      if (cw && cw.__easypaperNativePdfDispatch) cw.__easypaperNativePdfDispatch(ev);"
         "    } catch (e) {}"
         "  }"
         "})(%@);",
        json];
    dispatch_async(dispatch_get_main_queue(), ^{
        [web evaluateJavaScript:js completionHandler:nil];
    });
}

- (NSScrollView *)findInternalScrollView:(NSView *)root {
    if ([root isKindOfClass:[NSScrollView class]]) {
        return (NSScrollView *)root;
    }
    for (NSView *sub in root.subviews) {
        NSScrollView *found = [self findInternalScrollView:sub];
        if (found) return found;
    }
    return nil;
}

- (void)attachScrollNotifications {
    if (!self.pdfView) return;
    NSScrollView *sv = [self findInternalScrollView:self.pdfView];
    if (!sv || sv == self.scrollView) return;
    if (self.scrollView && self.scrollView.contentView) {
        [[NSNotificationCenter defaultCenter] removeObserver:self
                                                        name:NSViewBoundsDidChangeNotification
                                                      object:self.scrollView.contentView];
    }
    self.scrollView = sv;
    NSClipView *clip = sv.contentView;
    if (clip) {
        [clip setPostsBoundsChangedNotifications:YES];
        [[NSNotificationCenter defaultCenter] addObserver:self
                                                 selector:@selector(scrollBoundsChanged:)
                                                     name:NSViewBoundsDidChangeNotification
                                                   object:clip];
    }
}

- (void)scrollBoundsChanged:(NSNotification *)notification {
    if (self.suppressScrollReport) return;
    EPNativePdfView *view = self.pdfView;
    NSScrollView *sv = self.scrollView;
    if (!view || !sv || !view.document || !sv.documentView) return;

    NSRect docRect = sv.documentView.bounds;
    NSRect visibleRect = sv.contentView.documentVisibleRect;
    CGFloat maxScroll = docRect.size.height - visibleRect.size.height;
    double ratio = 0.0;
    if (maxScroll > 1.0) {
        if (sv.documentView.isFlipped) {
            ratio = visibleRect.origin.y / maxScroll;
        } else {
            ratio = (docRect.size.height - visibleRect.origin.y - visibleRect.size.height) / maxScroll;
        }
        if (ratio < 0.0) ratio = 0.0;
        if (ratio > 1.0) ratio = 1.0;
    }

    NSInteger pageNum = self.lastReportedPage > 0 ? self.lastReportedPage : 1;
    if (view.currentPage) {
        NSUInteger idx = [view.document indexForPage:view.currentPage];
        if (idx != NSNotFound) {
            pageNum = (NSInteger)idx + 1;
            self.lastReportedPage = pageNum;
        }
    }

    [self emitEvent:@{
        @"type": @"scroll",
        @"ratio": @(ratio),
        @"page": @(pageNum),
    }];
}

- (void)pageChanged:(NSNotification *)notification {
    EPNativePdfView *view = self.pdfView;
    if (!view || !view.document || !view.currentPage) return;
    NSUInteger idx = [view.document indexForPage:view.currentPage];
    if (idx == NSNotFound) return;
    NSInteger pageNum = (NSInteger)idx + 1;
    if (pageNum == self.lastReportedPage) return;
    self.lastReportedPage = pageNum;
    [self emitEvent:@{
        @"type": @"page",
        @"page": @(pageNum),
    }];
}

- (void)selectionChanged:(NSNotification *)notification {
    EPNativePdfView *view = self.pdfView;
    WKWebView *web = self.webView;
    if (!view || !web || !view.document) return;
    PDFSelection *sel = view.currentSelection;
    NSString *rawText = sel.string ?: @"";
    NSString *text = [rawText stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if (!sel || !text || text.length == 0 || sel.pages.count == 0) {
        [self emitEvent:@{ @"type": @"selection", @"empty": @YES }];
        return;
    }
    PDFPage *page = sel.pages.firstObject;
    NSUInteger pageIdx = [view.document indexForPage:page];
    if (pageIdx == NSNotFound) return;

    NSArray<PDFSelection *> *lines = [sel selectionsByLine];
    PDFSelection *firstLine = (lines && lines.count > 0) ? lines.firstObject : sel;
    NSRect pageBounds = [firstLine boundsForPage:page];
    if (NSIsEmptyRect(pageBounds) || pageBounds.size.width <= 0) {
        pageBounds = [sel boundsForPage:page];
    }
    NSRect viewRect = [view convertRect:pageBounds fromPage:page];
    NSRect webRect = [web convertRect:viewRect fromView:view];
    double topY = web.isFlipped ? webRect.origin.y : (NSHeight(web.bounds) - webRect.origin.y - webRect.size.height);

    NSString *pageText = page.string ?: @"";
    NSRange charRange = [pageText rangeOfString:rawText];
    if (charRange.location == NSNotFound && text.length > 0) {
        charRange = [pageText rangeOfString:text];
    }
    NSInteger startOffset = (charRange.location != NSNotFound) ? (NSInteger)charRange.location : -1;
    NSInteger endOffset = (charRange.location != NSNotFound) ? (NSInteger)(charRange.location + charRange.length) : -1;

    [self emitEvent:@{
        @"type": @"selection",
        @"empty": @NO,
        @"page": @(pageIdx + 1),
        @"text": rawText,
        @"startOffset": @(startOffset),
        @"endOffset": @(endOffset),
        @"rect": @{
            @"left": @(webRect.origin.x),
            @"top": @(topY),
            @"width": @(MAX(24.0, webRect.size.width)),
            @"height": @(MAX(16.0, webRect.size.height)),
        },
    }];
}

@end

static NSColor *ep_color_from_hex(NSString *hex, CGFloat alpha) {
    if (!hex || hex.length == 0) return [NSColor colorWithSRGBRed:0.918 green:0.702 blue:0.031 alpha:alpha];
    NSString *clean = [hex stringByTrimmingCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@"# "]];
    if (clean.length == 3) {
        clean = [NSString stringWithFormat:@"%C%C%C%C%C%C",
                 [clean characterAtIndex:0], [clean characterAtIndex:0],
                 [clean characterAtIndex:1], [clean characterAtIndex:1],
                 [clean characterAtIndex:2], [clean characterAtIndex:2]];
    }
    unsigned int rgb = 0;
    [[NSScanner scannerWithString:clean] scanHexInt:&rgb];
    CGFloat r = ((rgb >> 16) & 0xFF) / 255.0;
    CGFloat g = ((rgb >> 8) & 0xFF) / 255.0;
    CGFloat b = (rgb & 0xFF) / 255.0;
    return [NSColor colorWithSRGBRed:r green:g blue:b alpha:alpha];
}

static void ep_apply_payload_json(EPNativePdfView *view, const unsigned char *json_bytes, size_t json_len, bool sync_annotations) {
    if (!view || !json_bytes || json_len == 0) return;
    NSData *data = [NSData dataWithBytes:json_bytes length:json_len];
    NSDictionary *root = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![root isKindOfClass:[NSDictionary class]]) return;

    if ([root[@"overlayRects"] isKindOfClass:[NSArray class]]) {
        NSMutableArray<NSValue *> *rects = [NSMutableArray array];
        for (NSDictionary *r in root[@"overlayRects"]) {
            if (![r isKindOfClass:[NSDictionary class]]) continue;
            double rx = [r[@"x"] respondsToSelector:@selector(doubleValue)] ? [r[@"x"] doubleValue] : 0.0;
            double ry = [r[@"y"] respondsToSelector:@selector(doubleValue)] ? [r[@"y"] doubleValue] : 0.0;
            double rw = [r[@"width"] respondsToSelector:@selector(doubleValue)] ? [r[@"width"] doubleValue] : 0.0;
            double rh = [r[@"height"] respondsToSelector:@selector(doubleValue)] ? [r[@"height"] doubleValue] : 0.0;
            if (rw > 0 && rh > 0) {
                [rects addObject:[NSValue valueWithRect:NSMakeRect(rx, ry, rw, rh)]];
            }
        }
        view.interactiveWebRects = rects;
        [view updateOverlayCutoutMask];
    }

    if (!sync_annotations || !view.document) return;

    PDFDocument *doc = view.document;
    for (NSUInteger i = 0; i < doc.pageCount; i++) {
        PDFPage *page = [doc pageAtIndex:i];
        if (!page) continue;
        NSArray<PDFAnnotation *> *existing = [page.annotations copy];
        for (PDFAnnotation *ann in existing) {
            if ([ann.userName isEqualToString:@"easypaper"]) {
                [page removeAnnotation:ann];
            }
        }
    }

    NSDictionary *annotationsByPage = [root[@"annotations"] isKindOfClass:[NSDictionary class]] ? root[@"annotations"] : root;
    NSDictionary *memosByPage = [root[@"memos"] isKindOfClass:[NSDictionary class]] ? root[@"memos"] : @{};

    void (^addMarkup)(PDFPage *, NSString *, NSInteger, NSInteger, NSString *, NSString *, NSString *) =
        ^(PDFPage *page, NSString *quote, NSInteger startOff, NSInteger endOff, NSString *kind, NSString *hexColor, NSString *noteText) {
            PDFSelection *sel = nil;
            NSString *pageStr = page.string ?: @"";
            if (startOff >= 0 && endOff > startOff && (NSUInteger)endOff <= pageStr.length) {
                sel = [page selectionForRange:NSMakeRange((NSUInteger)startOff, (NSUInteger)(endOff - startOff))];
            }
            if ((!sel || sel.string.length == 0) && quote && quote.length > 0) {
                NSRange found = [pageStr rangeOfString:quote];
                if (found.location == NSNotFound) {
                    NSString *trimmed = [quote stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
                    if (trimmed.length > 0) found = [pageStr rangeOfString:trimmed];
                }
                if (found.location != NSNotFound && found.length > 0) {
                    sel = [page selectionForRange:found];
                }
            }
            if (!sel) return;
            NSArray<PDFSelection *> *lines = [sel selectionsByLine];
            if (!lines || lines.count == 0) lines = @[sel];
            BOOL isUnderline = [kind isEqualToString:@"underline"];
            PDFAnnotationSubtype subtype = isUnderline ? PDFAnnotationSubtypeUnderline : PDFAnnotationSubtypeHighlight;
            NSColor *color = ep_color_from_hex(hexColor, isUnderline ? 0.95 : 0.38);
            for (PDFSelection *line in lines) {
                NSRect bounds = [line boundsForPage:page];
                if (NSIsEmptyRect(bounds) || bounds.size.width <= 0 || bounds.size.height <= 0) continue;
                PDFAnnotation *ann = [[PDFAnnotation alloc] initWithBounds:bounds forType:subtype withProperties:nil];
                ann.userName = @"easypaper";
                ann.color = color;
                if (noteText && noteText.length > 0) ann.contents = noteText;
                [page addAnnotation:ann];
            }
        };

    for (NSString *pageKey in annotationsByPage) {
        if (![pageKey hasPrefix:@"page_"]) continue;
        NSInteger pageNum = [[pageKey substringFromIndex:5] integerValue];
        if (pageNum < 1 || (NSUInteger)pageNum > doc.pageCount) continue;
        PDFPage *page = [doc pageAtIndex:(NSUInteger)(pageNum - 1)];
        NSArray *items = annotationsByPage[pageKey];
        if (![items isKindOfClass:[NSArray class]]) continue;
        for (NSDictionary *item in items) {
            if (![item isKindOfClass:[NSDictionary class]]) continue;
            NSString *type = [item[@"type"] isKindOfClass:[NSString class]] ? item[@"type"] : @"highlight";
            NSString *text = [item[@"text"] isKindOfClass:[NSString class]] ? item[@"text"] : @"";
            NSString *color = [item[@"color"] isKindOfClass:[NSString class]] ? item[@"color"] : @"#eab308";
            NSInteger startOff = [item[@"startOffset"] respondsToSelector:@selector(integerValue)] ? [item[@"startOffset"] integerValue] : -1;
            NSInteger endOff = [item[@"endOffset"] respondsToSelector:@selector(integerValue)] ? [item[@"endOffset"] integerValue] : -1;
            addMarkup(page, text, startOff, endOff, type, color, nil);
        }
    }

    for (NSString *pageKey in memosByPage) {
        if (![pageKey hasPrefix:@"page_"]) continue;
        NSInteger pageNum = [[pageKey substringFromIndex:5] integerValue];
        if (pageNum < 1 || (NSUInteger)pageNum > doc.pageCount) continue;
        PDFPage *page = [doc pageAtIndex:(NSUInteger)(pageNum - 1)];
        NSArray *items = memosByPage[pageKey];
        if (![items isKindOfClass:[NSArray class]]) continue;
        for (NSDictionary *memo in items) {
            if (![memo isKindOfClass:[NSDictionary class]]) continue;
            NSString *text = [memo[@"sentenceText"] isKindOfClass:[NSString class]] ? memo[@"sentenceText"] : @"";
            NSString *content = [memo[@"content"] isKindOfClass:[NSString class]] ? memo[@"content"] : @"";
            NSString *colorName = [memo[@"color"] isKindOfClass:[NSString class]] ? memo[@"color"] : @"default";
            NSString *hex = @"#3b82f6";
            if ([colorName isEqualToString:@"yellow"]) hex = @"#eab308";
            else if ([colorName isEqualToString:@"green"]) hex = @"#10b981";
            else if ([colorName isEqualToString:@"red"]) hex = @"#f43f5e";
            NSInteger startOff = [memo[@"charStart"] respondsToSelector:@selector(integerValue)] ? [memo[@"charStart"] integerValue] : -1;
            NSInteger endOff = [memo[@"charEnd"] respondsToSelector:@selector(integerValue)] ? [memo[@"charEnd"] integerValue] : -1;
            addMarkup(page, text, startOff, endOff, @"highlight", hex, content);
        }
    }
}

bool ep_pdf_update(WKWebView *web, const unsigned char *bytes, size_t count,
                   double x, double y, double width, double height,
                   bool close, bool hidden, int target_page, double scroll_ratio, const char *action) {
    EPNativePdfView *view = objc_getAssociatedObject(web, &viewKey);
    EPNativePdfObserver *observer = objc_getAssociatedObject(web, &observerKey);

    if (close) {
        if (observer) {
            [[NSNotificationCenter defaultCenter] removeObserver:observer];
            objc_setAssociatedObject(web, &observerKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        }
        [view removeFromSuperview];
        objc_setAssociatedObject(web, &viewKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        return true;
    }

    NSString *act = action ? [NSString stringWithUTF8String:action] : @"update";
    if ([act isEqualToString:@"annotations"]) {
        if (!view) return false;
        ep_apply_payload_json(view, bytes, count, true);
        return true;
    }
    if ([act isEqualToString:@"overlays"]) {
        if (!view) return false;
        ep_apply_payload_json(view, bytes, count, false);
        return true;
    }
    if ([act isEqualToString:@"clear_selection"]) {
        [view clearSelection];
        return true;
    }

    if (count > 0 && [act isEqualToString:@"load"]) {
        PDFDocument *document = [[PDFDocument alloc] initWithData:[NSData dataWithBytes:bytes length:count]];
        if (!document || document.isLocked) return false;
        if (!view) {
            view = [[EPNativePdfView alloc] initWithFrame:NSZeroRect];
            view.hostWebView = web;
            view.displayMode = kPDFDisplaySinglePageContinuous;
            view.displaysPageBreaks = YES;
            view.autoScales = YES;
            view.wantsLayer = YES;
            [web addSubview:view];
            objc_setAssociatedObject(web, &viewKey, view, OBJC_ASSOCIATION_RETAIN_NONATOMIC);

            observer = [[EPNativePdfObserver alloc] init];
            observer.webView = web;
            observer.pdfView = view;
            observer.lastReportedPage = 1;
            objc_setAssociatedObject(web, &observerKey, observer, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
            [[NSNotificationCenter defaultCenter] addObserver:observer
                                                     selector:@selector(pageChanged:)
                                                         name:PDFViewPageChangedNotification
                                                       object:view];
            [[NSNotificationCenter defaultCenter] addObserver:observer
                                                     selector:@selector(selectionChanged:)
                                                         name:PDFViewSelectionChangedNotification
                                                       object:view];
        }
        view.document = document;
        view.autoScales = YES;
        [observer attachScrollNotifications];
    } else if (count > 0 && [act isEqualToString:@"update"]) {
        ep_apply_payload_json(view, bytes, count, false);
    }

    if (!view) return false;
    [observer attachScrollNotifications];
    view.hidden = hidden || width <= 4.0 || height <= 4.0;
    if (!view.hidden) {
        view.frame = NSMakeRect(x, web.isFlipped ? y : NSHeight(web.bounds) - y - height, width, height);
    }
    if (scroll_ratio >= 0.0 && scroll_ratio <= 1.0 && observer && observer.scrollView && observer.scrollView.documentView) {
        NSScrollView *sv = observer.scrollView;
        NSRect docRect = sv.documentView.bounds;
        NSRect visRect = sv.contentView.documentVisibleRect;
        CGFloat maxScroll = docRect.size.height - visRect.size.height;
        if (maxScroll > 1.0) {
            CGFloat targetY = sv.documentView.isFlipped
                ? (scroll_ratio * maxScroll)
                : (docRect.size.height - visRect.size.height - scroll_ratio * maxScroll);
            if (fabs(visRect.origin.y - targetY) > 2.0) {
                observer.suppressScrollReport = YES;
                [sv.contentView scrollToPoint:NSMakePoint(visRect.origin.x, targetY)];
                [sv reflectScrolledClipView:sv.contentView];
                observer.suppressScrollReport = NO;
            }
        }
    } else if (target_page > 0 && view.document && (NSUInteger)target_page <= view.document.pageCount) {
        PDFPage *page = [view.document pageAtIndex:(NSUInteger)(target_page - 1)];
        if (page && view.currentPage != page) {
            if (observer) observer.lastReportedPage = target_page;
            [view goToPage:page];
        }
    }
    return true;
}




