"""Publishes one of every message type the viewer draws that a sim usually doesn't, on dimos's zenoh keys, so each
layer can be checked by eye: markers (all types), 3D boxes, a graph, a pose array, labeled points, a grid, 2D boxes.

    python tools/synthetic_publisher.py [--connect tcp/127.0.0.1:7447] [--seconds 600]

Run with a dimos venv (dimos_lcm + eclipse-zenoh). dimos_lcm's classes share their nested default objects between
instances (ObjectHypothesisWithPose().hypothesis is the same object every time), so every nested field here is built
fresh. Everything is in frame `synthetic`, a child of `world` 3 m out on
x (published on /synthetic_tf), so the viewer has to go through TF to place it. Publishes nothing a robot listens to.
"""

import argparse
import json
import math
import struct
import time

import zenoh
from dimos_lcm.geometry_msgs import Point, Pose, PoseArray, PointStamped, Quaternion, Transform, TransformStamped, Vector3
from dimos_lcm.nav_msgs import OccupancyGrid, Path
from dimos_lcm.geometry_msgs import PoseStamped
from dimos_lcm.std_msgs import ColorRGBA, Header
from dimos_lcm.tf2_msgs import TFMessage
from dimos_lcm.vision_msgs import (
    BoundingBox2D,
    BoundingBox3D,
    BoundingBox3DArray,
    Detection2D,
    Detection2DArray,
    Detection3D,
    Detection3DArray,
    ObjectHypothesis,
    ObjectHypothesisWithPose,
    Point2D,
    Pose2D,
)
from dimos_lcm.visualization_msgs import Marker, MarkerArray

FRAME = "synthetic"


def header(frame: str = FRAME) -> Header:
    value = Header()
    now = time.time()
    value.stamp.sec = int(now)
    value.stamp.nsec = int((now % 1) * 1e9)
    value.frame_id = frame
    return value


def pose(x: float, y: float, z: float, yaw: float = 0.0) -> Pose:
    value = Pose()
    value.position = Point(x, y, z)
    value.orientation = Quaternion(0.0, 0.0, math.sin(yaw / 2), math.cos(yaw / 2))
    return value


def color(r: float, g: float, b: float, a: float = 1.0) -> ColorRGBA:
    return ColorRGBA(r, g, b, a)


def marker(marker_id: int, kind: int, at: Pose, scale: tuple, rgba: ColorRGBA, points=(), text: str = "") -> Marker:
    value = Marker()
    value.header = header()
    value.ns = "synthetic"
    value.id = marker_id
    value.type = kind
    value.action = 0
    value.pose = at
    value.scale = Vector3(*scale)
    value.color = rgba
    value.points = list(points)
    value.points_length = len(value.points)
    value.colors = []
    value.colors_length = 0
    value.text = text
    return value


def markers(t: float) -> MarkerArray:
    red, green, blue, gold = color(0.95, 0.3, 0.3), color(0.3, 0.9, 0.4), color(0.3, 0.5, 1.0), color(1.0, 0.8, 0.2)
    ring = [Point(math.cos(a) * 0.6, math.sin(a) * 0.6, 0.0) for a in [i * math.pi / 8 for i in range(17)]]
    items = [
        marker(0, Marker.ARROW, pose(0, 0, 0.2, t), (0.8, 0.08, 0.08), red),
        marker(1, Marker.CUBE, pose(1.0, 0, 0.25), (0.3, 0.3, 0.3), green),
        marker(2, Marker.SPHERE, pose(1.6, 0, 0.25), (0.3, 0.3, 0.3), blue),
        marker(3, Marker.CYLINDER, pose(2.2, 0, 0.25), (0.25, 0.25, 0.5), gold),
        marker(4, Marker.LINE_STRIP, pose(0, 1.2, 0.05), (0.04, 0, 0), green, ring),
        marker(5, Marker.LINE_LIST, pose(1.5, 1.2, 0.05), (0.03, 0, 0), red, [Point(0, 0, 0), Point(0.5, 0, 0), Point(0, 0.3, 0), Point(0.5, 0.3, 0)]),
        marker(6, Marker.CUBE_LIST, pose(0, -1.2, 0.1), (0.15, 0.15, 0.15), blue, [Point(i * 0.2, 0, 0) for i in range(6)]),
        marker(7, Marker.SPHERE_LIST, pose(0, -1.6, 0.1), (0.12, 0.12, 0.12), gold, [Point(i * 0.2, 0, 0.05 * math.sin(t + i)) for i in range(6)]),
        marker(8, Marker.POINTS, pose(1.6, -1.4, 0.1), (0.06, 0.06, 0), green, [Point(0.1 * i, 0.1 * j, 0) for i in range(5) for j in range(5)]),
        marker(9, Marker.TEXT_VIEW_FACING, pose(1.0, 0, 0.8), (0, 0, 0.2), color(1, 1, 1), text="text marker"),
        marker(10, Marker.TRIANGLE_LIST, pose(2.6, 1.2, 0.05), (1, 1, 1), red, [Point(0, 0, 0), Point(0.4, 0, 0), Point(0.2, 0.4, 0)]),
    ]
    array = MarkerArray()
    array.markers = items
    array.markers_length = len(items)
    return array


def detections3d() -> Detection3DArray:
    array = Detection3DArray()
    array.header = header()
    items = []
    for index, (name, x, score) in enumerate([("chair", -1.0, 0.92), ("person", -2.0, 0.81)]):
        detection = Detection3D()
        detection.header = header()
        hypothesis = ObjectHypothesisWithPose()
        hypothesis.hypothesis = ObjectHypothesis(name, score)
        detection.results = [hypothesis]
        detection.results_length = 1
        detection.bbox = BoundingBox3D()
        detection.bbox.center = pose(x, 0.0, 0.5 if name == "chair" else 0.9)
        detection.bbox.size = Vector3(0.6, 0.6, 1.0 if name == "chair" else 1.8)
        detection.id = f"det{index}"
        items.append(detection)
    array.detections = items
    array.detections_length = len(items)
    return array


def boxes3d() -> BoundingBox3DArray:
    array = BoundingBox3DArray()
    array.header = header()
    box = BoundingBox3D()
    box.center = pose(-1.5, 1.5, 0.3)
    box.size = Vector3(0.8, 0.4, 0.6)
    array.boxes = [box]
    array.boxes_length = 1
    return array


def graph(t: float) -> Path:
    """nav_msgs.LineSegments3D as dimos sends it: a Path of pose pairs, the weight in the first pose's orientation.w."""
    nodes = [(math.cos(i * math.pi / 3) * 1.2 - 3.0, math.sin(i * math.pi / 3) * 1.2, 0.3) for i in range(6)]
    edges = [(i, (i + 1) % 6) for i in range(6)] + [(0, 3), (1, 4)]
    path = Path()
    path.header = header()
    poses = []
    for edge_index, (a, b) in enumerate(edges):
        for end, node in enumerate((a, b)):
            stamped = PoseStamped()
            stamped.header = header()
            stamped.pose = pose(*nodes[node])
            stamped.pose.orientation = Quaternion(0, 0, 0, 10 ** (edge_index / 3) if end == 0 else 1.0)
            poses.append(stamped)
    path.poses = poses
    path.poses_length = len(poses)
    return path


def pose_array(t: float) -> PoseArray:
    array = PoseArray()
    array.header = header()
    array.poses = [pose(-1.0 + 0.4 * i, -2.5, 0.1, t + i * 0.5) for i in range(6)]
    array.poses_length = len(array.poses)
    return array


def entities() -> bytes:
    """visualization_msgs.EntityMarkers: a u32 length and JSON, no fingerprint (dimos's own format), world frame."""
    payload = json.dumps([
        {"id": "p1", "label": "Jeff", "type": "person", "x": 3.0, "y": 3.0, "z": 0.9},
        {"id": "o1", "label": "red mug", "type": "object", "x": 4.0, "y": 3.0, "z": 0.5},
        {"id": "l1", "label": "kitchen", "type": "location", "x": 5.0, "y": 3.0, "z": 0.2},
    ]).encode()
    return struct.pack(">I", len(payload)) + payload


def point_stamped(t: float) -> PointStamped:
    value = PointStamped()
    value.header = header()
    value.point = Point(-0.5, 2.5, 0.5 + 0.2 * math.sin(t))
    return value


def grid() -> OccupancyGrid:
    value = OccupancyGrid()
    value.header = header()
    value.info.resolution = 0.1
    value.info.width = 40
    value.info.height = 30
    value.info.origin = pose(-6.0, -1.5, 0.0)
    data = []
    for row in range(30):
        for col in range(40):
            data.append(-1 if row < 4 else 100 if (row in (10, 20) or col in (5, 30)) else (col * 3) % 101 if row > 24 else 0)
    value.data = data
    value.data_length = len(data)
    return value


def detections2d(t: float) -> Detection2DArray:
    array = Detection2DArray()
    array.header = header("camera_optical")
    items = []
    for index, (name, x, y, w, h) in enumerate([("person", 200 + 60 * math.sin(t), 240, 120, 260), ("dog", 480, 330, 140, 100)]):
        detection = Detection2D()
        detection.header = header("camera_optical")
        hypothesis = ObjectHypothesisWithPose()
        hypothesis.hypothesis = ObjectHypothesis(name, 0.9 - 0.1 * index)
        detection.results = [hypothesis]
        detection.results_length = 1
        detection.bbox = BoundingBox2D()
        detection.bbox.center = Pose2D(Point2D(x, y), 0.0)
        detection.bbox.size_x = w
        detection.bbox.size_y = h
        detection.id = name
        items.append(detection)
    array.detections = items
    array.detections_length = len(items)
    return array


def tf() -> TFMessage:
    edge = TransformStamped()
    edge.header = header("world")
    edge.child_frame_id = FRAME
    edge.transform = Transform(Vector3(3.0, 0.0, 0.0), Quaternion(0, 0, 0, 1))
    message = TFMessage()
    message.transforms = [edge]
    message.transforms_length = 1
    return message


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--connect", default="", help="zenoh endpoint (default: peer on the local network)")
    parser.add_argument("--seconds", type=float, default=600)
    arguments = parser.parse_args()
    config = zenoh.Config()
    if arguments.connect:
        config.insert_json5("connect/endpoints", json.dumps([arguments.connect]))
    session = zenoh.open(config)
    started = time.time()
    while time.time() - started < arguments.seconds:
        t = time.time() - started
        for key, message in [
            ("dimos/synthetic_tf/tf2_msgs.TFMessage", tf()),
            ("dimos/synthetic_markers/visualization_msgs.MarkerArray", markers(t)),
            ("dimos/synthetic_detections/vision_msgs.Detection3DArray", detections3d()),
            ("dimos/synthetic_boxes/vision_msgs.BoundingBox3DArray", boxes3d()),
            ("dimos/synthetic_graph/nav_msgs.LineSegments3D", graph(t)),
            ("dimos/synthetic_poses/geometry_msgs.PoseArray", pose_array(t)),
            ("dimos/synthetic_point/geometry_msgs.PointStamped", point_stamped(t)),
            ("dimos/synthetic_grid/nav_msgs.OccupancyGrid", grid()),
            ("dimos/synthetic_detections_2d/vision_msgs.Detection2DArray", detections2d(t)),
        ]:
            session.put(key, message.lcm_encode())
        session.put("dimos/synthetic_entities/visualization_msgs.EntityMarkers", entities())
        time.sleep(0.2)
    session.close()


if __name__ == "__main__":
    main()
