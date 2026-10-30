package android.graphics;
public class ColorSpace {
    private final boolean srgb;
    public ColorSpace(boolean srgb){this.srgb=srgb;}
    public boolean isSrgb(){return srgb;}
}
