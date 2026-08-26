/**
 * Tracing bridge for pdfkit's standard fonts. pdfkit lazy-loads them
 * through #standard-fonts/* subpath requires inside its bundled entry,
 * which Vercel's function tracer can't follow, so the font files drop out
 * of the serverless bundle and PDF renders die with MODULE_NOT_FOUND in
 * production. Because this package lives in node_modules it ships
 * un-bundled, and its literal requires are exactly what the tracer can
 * resolve (require conditions -> the .cjs fonts). The requires are also
 * harmless at runtime: pdfkit loads the same files itself on first use.
 */
require("pdfkit/standard-fonts/Courier");
require("pdfkit/standard-fonts/CourierBold");
require("pdfkit/standard-fonts/CourierBoldOblique");
require("pdfkit/standard-fonts/CourierOblique");
require("pdfkit/standard-fonts/Helvetica");
require("pdfkit/standard-fonts/HelveticaBold");
require("pdfkit/standard-fonts/HelveticaBoldOblique");
require("pdfkit/standard-fonts/HelveticaOblique");
require("pdfkit/standard-fonts/Symbol");
require("pdfkit/standard-fonts/TimesBold");
require("pdfkit/standard-fonts/TimesBoldItalic");
require("pdfkit/standard-fonts/TimesItalic");
require("pdfkit/standard-fonts/TimesRoman");
require("pdfkit/standard-fonts/ZapfDingbats");
