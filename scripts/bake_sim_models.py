"""Bakes the 3D view's models of dimos's MuJoCo sim robots (frontend/public/robots/sim_<name>.glb).

dimos's MuJoCo sim (`--simulation mujoco` on unitree-go2, and the unitree-g1 *-sim blueprints) runs the MuJoCo
Menagerie's unitree_go1 / unitree_g1 with dimos's MJCF (data/mujoco_sim/unitree_<robot>.xml), and publishes only the
root body's pose (odom, tf base_link = the freejoint's qpos), no joint angles. So the model is the visual meshes in the
"home" keyframe, in the root body's frame, merged per color and decimated: one small GLB per robot.

Run with a dimos checkout's venv (it has mujoco, trimesh, open3d and the menagerie):
    <dimos>/.venv/bin/python scripts/bake_sim_models.py <dimos>
"""

import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import mujoco
import numpy as np
import open3d as o3d
import trimesh

ROBOTS = {
    # name in the app: (MJCF in data/mujoco_sim, menagerie folder, triangles to keep)
    "go2": ("unitree_go1.xml", "unitree_go1", 24_000),
    "g1": ("unitree_g1.xml", "unitree_g1", 40_000),
}


def menagerie_path(venv_site: Path) -> Path:
    return venv_site / "mujoco_playground" / "external_deps" / "mujoco_menagerie"


def load(dimos: Path, xml_name: str, menagerie_dir: Path) -> mujoco.MjModel:
    sim_data = dimos / "data" / "mujoco_sim"
    assets = {file.name: file.read_bytes() for file in (menagerie_dir / "assets").iterdir() if file.is_file()}
    assets[xml_name] = (sim_data / xml_name).read_bytes()
    # as dimos loads it (simulation/mujoco/model.py get_model_xml): the robot included in a scene (its floor)
    scene = ET.fromstring((sim_data / "scene_empty.xml").read_text())
    scene.insert(0, ET.Element("include", file=xml_name))
    return mujoco.MjModel.from_xml_string(ET.tostring(scene, encoding="unicode"), assets=assets)


def bake(model: mujoco.MjModel, triangles: int) -> trimesh.Scene:
    data = mujoco.MjData(model)
    mujoco.mj_resetDataKeyframe(model, data, model.keyframe("home").id)
    mujoco.mj_forward(model, data)
    root = 1  # the body with the freejoint: odom is its pose
    root_rotation = data.xmat[root].reshape(3, 3)
    root_position = data.xpos[root]
    by_color: dict[tuple, list[trimesh.Trimesh]] = {}
    for geom in range(model.ngeom):
        visual = model.geom_contype[geom] == 0 and model.geom_conaffinity[geom] == 0
        if not visual or model.geom_bodyid[geom] == 0 or model.geom_type[geom] != mujoco.mjtGeom.mjGEOM_MESH:
            continue
        mesh_id = model.geom_dataid[geom]
        start, count = model.mesh_vertadr[mesh_id], model.mesh_vertnum[mesh_id]
        face_start, face_count = model.mesh_faceadr[mesh_id], model.mesh_facenum[mesh_id]
        vertices = model.mesh_vert[start : start + count]
        faces = model.mesh_face[face_start : face_start + face_count]
        world = vertices @ data.geom_xmat[geom].reshape(3, 3).T + data.geom_xpos[geom]
        local = (world - root_position) @ root_rotation
        material = model.geom_matid[geom]
        rgba = model.mat_rgba[material] if material >= 0 else model.geom_rgba[geom]
        key = tuple(np.round(rgba, 3))
        by_color.setdefault(key, []).append(trimesh.Trimesh(local, faces, process=False))
    total = sum(sum(len(part.faces) for part in parts) for parts in by_color.values())
    scene = trimesh.Scene()
    for index, (rgba, parts) in enumerate(sorted(by_color.items())):
        merged = trimesh.util.concatenate(parts)
        target = max(200, int(len(merged.faces) * triangles / total))
        if len(merged.faces) > target:
            o3d_mesh = o3d.geometry.TriangleMesh(
                o3d.utility.Vector3dVector(merged.vertices), o3d.utility.Vector3iVector(merged.faces)
            )
            o3d_mesh = o3d_mesh.simplify_quadric_decimation(target)
            merged = trimesh.Trimesh(np.asarray(o3d_mesh.vertices), np.asarray(o3d_mesh.triangles))
        merged.visual = trimesh.visual.TextureVisuals(
            material=trimesh.visual.material.PBRMaterial(
                baseColorFactor=[int(round(channel * 255)) for channel in rgba], metallicFactor=0.1, roughnessFactor=0.7
            )
        )
        scene.add_geometry(merged, node_name=f"part{index}")
    return scene


def main() -> None:
    dimos = Path(sys.argv[1]).resolve()
    site = next((dimos / ".venv" / "lib").glob("python3*/site-packages"))
    out = Path(__file__).resolve().parent.parent / "frontend" / "public" / "robots"
    for name, (xml_name, folder, triangles) in ROBOTS.items():
        model = load(dimos, xml_name, menagerie_path(site) / folder)
        scene = bake(model, triangles)
        path = out / f"sim_{name}.glb"
        path.write_bytes(scene.export(file_type="glb"))
        faces = sum(len(geometry.faces) for geometry in scene.geometry.values())
        print(f"{path.name}: {faces} triangles, {path.stat().st_size // 1024} KB, extent {scene.extents.round(2)}")


if __name__ == "__main__":
    main()
