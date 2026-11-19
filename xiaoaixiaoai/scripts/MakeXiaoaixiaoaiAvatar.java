// Build-time image derivation only. Source artwork retains its original rights.
// Run: java -Djava.awt.headless=true scripts/MakeXiaoaixiaoaiAvatar.java <source.jpg> <output-directory>
import java.awt.AlphaComposite;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.geom.Ellipse2D;
import java.awt.image.BufferedImage;
import java.io.File;
import javax.imageio.ImageIO;

class MakeXiaoaixiaoaiAvatar {
  static BufferedImage square(BufferedImage source, int size) {
    int side = Math.min(source.getWidth(), source.getHeight());
    // Keep the face and upper body in a square; retain the untouched source too.
    int y = Math.min(Math.round(source.getHeight() * 0.045f), source.getHeight() - side);
    int x = (source.getWidth() - side) / 2;
    BufferedImage output = new BufferedImage(size, size, BufferedImage.TYPE_INT_RGB);
    Graphics2D g = output.createGraphics();
    g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC);
    g.drawImage(source, 0, 0, size, size, x, y, x + side, y + side, null);
    g.dispose();
    return output;
  }
  public static void main(String[] args) throws Exception {
    if (args.length != 2) throw new IllegalArgumentException("expected source.jpg and output-directory");
    BufferedImage source = ImageIO.read(new File(args[0]));
    if (source == null) throw new IllegalArgumentException("source is not a supported image");
    File dir = new File(args[1]);
    if (!dir.isDirectory()) throw new IllegalArgumentException("output directory must already exist");
    ImageIO.write(square(source, 1024), "png", new File(dir, "xiaoaixiaoai-icon.png"));
    ImageIO.write(square(source, 512), "png", new File(dir, "aimisi-avatar.png"));
    ImageIO.write(square(source, 256), "jpeg", new File(dir, "aimisi-web.jpg"));
    BufferedImage adaptive = new BufferedImage(1024, 1024, BufferedImage.TYPE_INT_ARGB);
    Graphics2D g = adaptive.createGraphics();
    g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
    g.setColor(new Color(255, 255, 255, 255));
    g.fill(new Ellipse2D.Double(182, 182, 660, 660));
    g.setComposite(AlphaComposite.SrcIn);
    g.drawImage(square(source, 660), 182, 182, null);
    g.dispose();
    ImageIO.write(adaptive, "png", new File(dir, "xiaoaixiaoai-adaptive.png"));
    System.out.println("Created 小爱小爱 icon, adaptive foreground and 爱弥斯 avatar from the user-provided source.");
  }
}
