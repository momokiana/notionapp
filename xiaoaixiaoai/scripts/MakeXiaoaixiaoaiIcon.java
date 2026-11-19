// Launcher treatment for the supplied 愛弥斯 portrait; no new character artwork.
// java -Djava.awt.headless=true scripts/MakeXiaoaixiaoaiIcon.java apps/mobile/assets/brand/aimisi-avatar.png <output-dir>
import java.awt.*;
import java.awt.geom.*;
import java.awt.image.BufferedImage;
import java.nio.file.*;
import javax.imageio.ImageIO;

class MakeXiaoaixiaoaiIcon {
  static final int N = 1024;
  static final int CENTER = N / 2;
  static final int SAFE_RADIUS = 311; // 66dp safe circle on the 108dp Android layers, rounded inward.

  static Color color(String hex) { return Color.decode(hex); }
  static Graphics2D graphics(BufferedImage image) {
    var g = image.createGraphics();
    g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
    g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC);
    g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
    return g;
  }
  static Paint diagonal(int x0, int y0, int x1, int y1, String a, String b, String c) {
    return new LinearGradientPaint(x0, y0, x1, y1, new float[] {0, .5f, 1}, new Color[] {color(a), color(b), color(c)});
  }
  static void disc(Graphics2D g, double x, double y, double r, Paint fill) {
    g.setPaint(fill);
    g.fill(new Ellipse2D.Double(x-r, y-r, r*2, r*2));
  }
  static BufferedImage field() {
    var img = new BufferedImage(N, N, BufferedImage.TYPE_INT_RGB);
    var g = graphics(img);
    g.setPaint(diagonal(160, 170, 850, 880, "#A6E1FC", "#EDF3FF", "#F8C1DD"));
    g.fillRect(0, 0, N, N);
    // A pearl glow behind the portrait, with dimensions independent of the launcher mask.
    g.setPaint(new RadialGradientPaint(485, 466, 426, new float[] {0, .55f, 1},
        new Color[] {new Color(255,255,255,235), new Color(255,255,255,115), new Color(255,255,255,0)}));
    g.fillRect(0, 0, N, N);
    g.dispose();
    return img;
  }
  static void orbit(Graphics2D g, double angle, int rx, int ry, Color c) {
    AffineTransform restore = g.getTransform();
    g.rotate(Math.toRadians(angle), CENTER, CENTER);
    g.setColor(c);
    g.setStroke(new BasicStroke(9, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
    g.draw(new Ellipse2D.Double(CENTER-rx, CENTER-ry, 2*rx, 2*ry));
    g.setTransform(restore);
  }
  static Path2D star(int cx, int cy, int r) {
    double n = r * .24;
    var p = new Path2D.Double();
    p.moveTo(cx, cy-r);
    p.quadTo(cx+n, cy-n, cx+r, cy);
    p.quadTo(cx+n, cy+n, cx, cy+r);
    p.quadTo(cx-n, cy+n, cx-r, cy);
    p.quadTo(cx-n, cy-n, cx, cy-r);
    p.closePath();
    return p;
  }
  static void spark(Graphics2D g, int x, int y, int r, String hex) {
    g.setPaint(color("#FFFFFF"));
    g.fill(star(x,y,r+10));
    g.setPaint(color(hex));
    g.fill(star(x,y,r));
  }
  static BufferedImage face(BufferedImage source, int size) {
    var piece = new BufferedImage(size, size, BufferedImage.TYPE_INT_ARGB);
    var g = graphics(piece);
    disc(g, size/2d, size/2d, size/2d, Color.WHITE);
    g.setComposite(AlphaComposite.SrcIn);
    g.drawImage(source, 0, 0, size, size, null);
    g.dispose();
    return piece;
  }
  static BufferedImage emblem(BufferedImage source) {
    var img = new BufferedImage(N, N, BufferedImage.TYPE_INT_ARGB);
    var g = graphics(img);
    orbit(g, -25, 300, 200, color("#62C2EA"));
    orbit(g, 20, 295, 191, color("#E78FBE"));
    disc(g, 512, 519, 261, diagonal(269,270,754,756,"#65C7F1", "#B9B3F1", "#EC8ABB"));
    disc(g, 512, 519, 243, color("#FFFBFF"));
    g.drawImage(face(source, 466), 279, 286, null);
    spark(g, 699, 315, 25, "#28688F");
    spark(g, 314, 695, 17, "#94406F");
    disc(g, 749, 393, 8, color("#73B9E0"));
    g.dispose();
    // The user's portrait and recognisable accessories must not disappear across adaptive masks.
    for (int y=0; y<N; y++) for (int x=0; x<N; x++) {
      int dx=x-CENTER, dy=y-CENTER;
      if (dx*dx+dy*dy > SAFE_RADIUS*SAFE_RADIUS && (img.getRGB(x,y) >>> 24) > 8) {
        throw new IllegalStateException("foreground clips outside the adaptive safe circle");
      }
    }
    return img;
  }
  static BufferedImage fallback(BufferedImage bg, BufferedImage fg) {
    var image = new BufferedImage(N, N, BufferedImage.TYPE_INT_RGB);
    var g = graphics(image);
    // Match the visible center of the adaptive icon; keep the legacy icon opaque at all edges.
    g.drawImage(bg,0,0,N,N,160,160,864,864,null);
    g.drawImage(fg,0,0,N,N,160,160,864,864,null);
    g.dispose();
    return image;
  }
  public static void main(String[] args) throws Exception {
    if(args.length != 2) throw new IllegalArgumentException("expected the existing square portrait and output directory");
    var portrait = ImageIO.read(Path.of(args[0]).toFile());
    var dir = Path.of(args[1]);
    if (portrait == null || portrait.getWidth() != portrait.getHeight() || !Files.isDirectory(dir)) {
      throw new IllegalArgumentException("portrait must be a square image and output directory must exist");
    }
    var background = field();
    var foreground = emblem(portrait);
    for (String name : new String[] {"starlight-launcher.png","starlight-launcher-fg.png","starlight-launcher-bg.png"}) {
      if(Files.exists(dir.resolve(name))) throw new IllegalArgumentException("use an empty output directory; will not overwrite "+name);
    }
    ImageIO.write(fallback(background, foreground), "png", dir.resolve("starlight-launcher.png").toFile());
    ImageIO.write(foreground, "png", dir.resolve("starlight-launcher-fg.png").toFile());
    ImageIO.write(background, "png", dir.resolve("starlight-launcher-bg.png").toFile());
    System.out.println("Generated 1024px launcher artwork; all significant foreground pixels fit inside the adaptive safe circle.");
  }
}
