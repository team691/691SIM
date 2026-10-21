"""Raspberry Pi — single-board vision coprocessor, same I/O layout as the
Orange Pi diagram: USB-C power, Gigabit Ethernet, HDMI, 2x USB-A, GPIO
header, 4 corner mounting holes. Green PCB to match the Pi family look.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from style import *

HERE = os.path.dirname(os.path.abspath(__file__))

W, H = 420, 340
BOARD = (20, 20, 400, 320)

EDGE_H = 30
USBC_Y, ETH_Y, HDMI_Y = 76, 122, 168
USB3A_Y, USB3B_Y = 76, 122

GPIO_Y, GPIO_X0, GPIO_PITCH = 244, 100, 16

PORT_EDGES = {
    "USB_C_PWR": ("left", 20, USBC_Y + EDGE_H / 2),
    "ETH": ("left", 20, ETH_Y + EDGE_H / 2),
    "HDMI": ("left", 20, HDMI_Y + EDGE_H / 2),
    "USB3_1": ("right", 400, USB3A_Y + EDGE_H / 2),
    "USB3_2": ("right", 400, USB3B_Y + EDGE_H / 2),
}

im, d = canvas(W, H)

# Raspberry Pi–style green PCB
rr(d, BOARD, 10, fill=(34, 92, 52), outline=C["edge"], w=2)
for cx, cy in ((36, 36), (384, 36), (36, 304), (384, 304)):
    mount_hole(d, cx, cy, 7)

text(d, (210, 34), "Raspberry Pi", F(BOLD, 15), C["text"])
text(d, (210, 54), "vision coprocessor", F(REG, 10), C["silk"])

for y, label in ((USBC_Y, "USB-C PWR"), (ETH_Y, "ETH"), (HDMI_Y, "HDMI")):
    box = (20, y, 20 + 44, y + EDGE_H)
    if label == "ETH":
        rj45(d, box)
    elif label == "HDMI":
        rr(d, box, 3, fill=(56, 58, 64), outline=(28, 30, 34), w=2)
        rect(d, (box[0] + 10, box[1] + 6, box[2] - 4, box[3] - 6), fill=(20, 21, 24))
    else:
        rr(d, box, 4, fill=(216, 218, 222), outline=(150, 152, 158), w=1)
        rect(d, (box[0] + 14, box[1] + 8, box[2] - 6, box[3] - 8), fill=(60, 62, 68))
    text(d, (20 + 52, y + EDGE_H / 2), label, F(REG, 10), C["silk"], anchor="lm")

for y, label in ((USB3A_Y, "USB"), (USB3B_Y, "USB")):
    box = (400 - 44, y, 400, y + EDGE_H)
    usb(d, box, kind="A")
    text(d, (400 - 52, y + EDGE_H / 2), label, F(REG, 10), C["silk"], anchor="rm")

text(d, (140, GPIO_Y - 14), "GPIO 40-pin", F(REG, 9), C["silk"])
for row in range(2):
    for col in range(20):
        gx = GPIO_X0 + col * GPIO_PITCH
        gy = GPIO_Y + row * 14
        circ(d, gx, gy, 3, fill=(214, 216, 220))

text(d, (210, 190), "µSD", F(REG, 9), C["silk"])
rr(d, (196, 200, 224, 216), 2, fill=(30, 32, 36), outline=(60, 62, 68), w=1)

save(im, os.path.join(HERE, "raspberrypi.png"), W)
dump_ports(PORT_EDGES, os.path.join(HERE, "raspberrypi-ports.json"))
