"""CTR Electronics CANivore -- USB-to-CAN FD bus expansion.

Adds a secondary CAN FD bus to the roboRIO. From the CTRE store listing and
the Phoenix 6 CANivore docs:
  - USB-C to the roboRIO; the roboRIO ships with the canivore-usb kernel
    module preinstalled, so no driver setup is needed.
  - Weidmuller terminals: V+ / V- and CANH / CANL.
    CANH is the YELLOW wire, CANL is the GREEN wire.
  - Flexible power: USB only, 6-28V via V+/V- only, or BOTH at once for a
    redundant dual supply. STAT red double-blink = powered via V+/V- but
    no USB.
  - Termination is NOT a physical switch (unlike the PDP's TERM jumper).
    The bus still needs 120 ohms at each end; CTRE sells a resistor for the
    far end.
  - Every device on a CANivore bus must be CAN FD capable.
  - Four status LEDs: STAT, CAN, WIFI, BT. WIFI/BT read "off" when those
    radios are disabled, which is the normal FRC state.
  - The device can be renamed in Phoenix Tuner X; DEVICE_NAME shows that.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from style import *

HERE = os.path.dirname(os.path.abspath(__file__))

# ---------------- editable ----------------
DEVICE_NAME = ""          # Tuner-assigned name e.g. "drivetrain"; "" hides the tag
LED_STAT = "green"        # "green" | "red" | "orange" | "off"
LED_CAN  = "green"
LED_WIFI = "off"
LED_BT   = "off"

LED_COLORS = {"green": (86, 214, 96), "red": (214, 64, 54),
              "orange": (232, 150, 44), "off": (56, 60, 68)}

# ---------------- geometry ----------------
W, H = 620, 400
BODY = (112, 62, 508, 330)

USBC_X, USBC_CY = 52, 196         # outer face of the USB-C shell
TERM_X = 576                      # outer face of the terminal block
TERM_Y0, TERM_PITCH, TERM_H = 96, 48, 40
TERMS = [("V+",   C["posred"]),
         ("V-",   (120, 124, 132)),
         ("CANH", C["yellow"]),
         ("CANL", C["canlgrn"])]

PORT_EDGES = {"USB-C": ("left", USBC_X, USBC_CY)}
for i, (name, _) in enumerate(TERMS):
    PORT_EDGES[name] = ("right", TERM_X, TERM_Y0 + i * TERM_PITCH + TERM_H / 2)
# Resolved:
#   USB-C left    52, 196
#   V+    right  576, 116      CANH  right  576, 212
#   V-    right  576, 164      CANL  right  576, 260

im, d = canvas(W, H)

# anodised aluminium case
rr(d, BODY, 10, fill=(38, 40, 46), outline=C["edge"], w=2)
rr(d, (126, 76, 494, 316), 8, fill=(46, 48, 55), outline=(62, 66, 74), w=2)
mount_hole(d, 150, 98, 10)
mount_hole(d, 150, 294, 10)

# USB-C port, left end
rr(d, (USBC_X, USBC_CY - 36, 126, USBC_CY + 36), 6,
   fill=C["board2"], outline=C["grey"], w=2)
rr(d, (USBC_X + 10, USBC_CY - 25, USBC_X + 42, USBC_CY + 25), 11,
   fill=C["black"], outline=C["grey"], w=2)
rect(d, (USBC_X + 17, USBC_CY - 17, USBC_X + 35, USBC_CY + 17), fill=C["grey"])
text(d, (88, 252), "USB-C", F(BOLD, 11), C["silk"])
text(d, (88, 270), "roboRIO", F(REG, 9), C["silk"])

# Weidmuller terminal block, right end
rr(d, (494, TERM_Y0 - 10, TERM_X, TERM_Y0 + 4 * TERM_PITCH), 5,
   fill=C["white"], outline=C["white_d"], w=2)
for i, (name, col) in enumerate(TERMS):
    y = TERM_Y0 + i * TERM_PITCH
    rect(d, (514, y + 8, 566, y + 32), fill=C["board2"])
    rect(d, (500, y + 4, 510, y + TERM_H - 4), fill=col)
    text(d, (486, y + TERM_H / 2), name, F(BOLD, 12), C["text"], anchor="rm")

# branding
text(d, (300, 126), "CANivore", F(BOLD, 30), C["text"])
text(d, (300, 160), "USB  →  CAN FD", F(REG, 13), C["silk"])
text(d, (300, 182), "CTR ELECTRONICS", F(REG, 9), C["silk"])
if DEVICE_NAME:
    rr(d, (228, 196, 372, 222), 4, fill=C["board2"], outline=C["edge"], w=2)
    text(d, (300, 209), DEVICE_NAME, F(MONO, 12), C["orange"])

# status LEDs
for i, (lab, st) in enumerate((("STAT", LED_STAT), ("CAN", LED_CAN),
                               ("WIFI", LED_WIFI), ("BT", LED_BT))):
    cx = 204 + i * 64
    circ(d, cx, 250, 11, fill=LED_COLORS[st], outline=C["edge"], w=2)
    text(d, (cx, 274), lab, F(REG, 9), C["silk"])

text(d, (300, 296), "secondary CAN FD bus  ·  FD-capable devices only",
     F(REG, 10), C["silk"])
text(d, (300, 362), "power: USB, or 6-28V on V+/V-, or both", F(REG, 11), C["silk"])

save(im, os.path.join(HERE, "canivore.png"), W)
dump_ports(PORT_EDGES, os.path.join(HERE, "canivore-ports.json"))
