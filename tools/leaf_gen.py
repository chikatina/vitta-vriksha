import math

# Reference colors from user image:
BG_COLOR = "#0A3D31"
TRUNK_COLOR = "#FAF3E8"
COIN_GOLD = "#FBBF24"
COIN_RIM = "#EAB308"
LEAF_LIGHT = "#84CC16"
LEAF_DARK = "#4E9A45"
LEAF_MID = "#65A30D"
FRUIT_GOLD = "#EAB308"

def make_leaf_path(cx, cy, length, width, angle_deg, color):
    # Almond shaped leaf centered at cx, cy oriented along angle_deg
    rad = math.radians(angle_deg)
    cos_a = math.cos(rad)
    sin_a = math.sin(rad)
    
    # Local coordinates: tip at (0, -length/2), base at (0, length/2), left control at (-width/2, 0), right control at (width/2, 0)
    hl = length / 2.0
    hw = width / 2.0
    
    def transform(x, y):
        # Rotate by angle_deg then translate to cx, cy
        rx = x * cos_a - y * sin_a + cx
        ry = x * sin_a + y * cos_a + cy
        return f"{rx:.2f},{ry:.2f}"
    
    # Path using cubic beziers for smooth almond shape
    p_top = transform(0, -hl)
    p_bot = transform(0, hl)
    
    c1_right = transform(hw * 1.1, -hl * 0.4)
    c2_right = transform(hw * 1.1, hl * 0.4)
    
    c1_left = transform(-hw * 1.1, hl * 0.4)
    c2_left = transform(-hw * 1.1, -hl * 0.4)
    
    d = f"M {p_bot} C {c2_right} {c1_right} {p_top} C {c2_left} {c1_left} {p_bot} Z"
    return f'<path android:fillColor="{color}" android:pathData="{d}" />'

print("Leaf helper ready")
