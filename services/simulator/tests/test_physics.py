import math
import pytest

from cubesat_sim.physics import (
    C_M_S, K_B_J_K, HALF_WAVE_DIRECTIVITY, WGS84_A_M,
    dot, norm, unit, cross, matvec, rz, rotation, quaternion_from_matrix,
    geodetic_ecef, enu_axes, horizontal_feed, fspl_db, noise_density_dbw_hz,
    half_wave_dipole, short_dipole_turnstile, cosine_patch, polarization_coupling,
    integrate_piecewise,
)


def test_free_space_hand_case_and_inverse_square():
    # lambda=1 m, r=1/(4pi) m => unity Friis loss, independent hand construction.
    assert fspl_db(1/(4*math.pi), C_M_S) == pytest.approx(0, abs=1e-12)
    assert fspl_db(1e6, 2.4e9) == pytest.approx(160.0520080561155, abs=1e-10)
    assert fspl_db(2e6, 2.4e9)-fspl_db(1e6, 2.4e9) == pytest.approx(20*math.log10(2))
    assert noise_density_dbw_hz(290) == pytest.approx(10*math.log10(290*K_B_J_K), abs=1e-12)


def test_geodetic_reference_and_local_axes():
    assert geodetic_ecef(0, 0, 0) == pytest.approx((6378137, 0, 0), abs=1e-8)
    assert geodetic_ecef(90, 0, 0) == pytest.approx((0, 0, 6356752.314245179), abs=1e-7)
    east, north, up = enu_axes(37.4275, -122.1697)
    assert cross(east, north) == pytest.approx(up)
    assert all(norm(a) == pytest.approx(1) for a in (east, north, up))
    assert dot(east, north) == pytest.approx(0, abs=1e-15)


def test_horizon_horizontal_feed_not_projected_east():
    east, north, up = enu_axes(37.4, -122.1)
    # Non-cardinal azimuth and elevation expose a projected-east roll error.
    look = unit(tuple(.6*e+.8*n+.7*u for e,n,u in zip(east,north,up)))
    feed = horizontal_feed(east, north, look)
    assert dot(feed, up) == pytest.approx(0, abs=1e-14)
    assert dot(feed, look) == pytest.approx(0, abs=1e-14)
    assert norm(feed) == pytest.approx(1)
    assert horizontal_feed(east, north, up) == pytest.approx(east)
    rolled = horizontal_feed(east, north, look, 90)
    assert dot(rolled, feed) == pytest.approx(0, abs=1e-14)


def test_quaternion_known_90_degree_rotation():
    matrix = rz(math.pi/2)
    w,x,y,z = quaternion_from_matrix(matrix)
    assert (w,x,y,z) == pytest.approx((2**-.5,0,0,2**-.5), abs=1e-14)
    # Hamilton q v q* agrees with the matrix, rather than its transpose.
    v=(1,0,0)
    uv=cross((x,y,z),v); uuv=cross((x,y,z),uv)
    rotated=tuple(v[i]+2*(w*uv[i]+uuv[i])for i in range(3))
    assert rotated == pytest.approx(matvec(matrix,v), abs=1e-14)


def test_halfwave_null_broadside_and_power_normalization():
    assert half_wave_dipole((1,0,0),(1,0,0)).gain_linear == 0
    assert half_wave_dipole((1,0,0),(-1,0,0)).polarization is None
    broadside=half_wave_dipole((1,0,0),(0,1,0))
    assert broadside.gain_linear == pytest.approx(HALF_WAVE_DIRECTIVITY)
    # Midpoint quadrature over cos(theta), analytically azimuth-independent.
    n=10000
    average=sum(half_wave_dipole((0,0,1),(math.sqrt(1-u*u),0,u)).gain_linear
                for u in (-1+(i+.5)*2/n for i in range(n)))/n
    assert average == pytest.approx(1, abs=1e-7)


def test_turnstile_one_total_power_and_directional_polarization():
    assert short_dipole_turnstile((1,0,0),(0,0,1),(0,1,0)).gain_linear == pytest.approx(1.5)
    assert short_dipole_turnstile((1,0,0),(0,0,1),(1,0,0)).gain_linear == pytest.approx(.75)
    n=4000;golden=math.pi*(3-math.sqrt(5));total=0
    for i in range(n):
        y=1-2*(i+.5)/n;r=math.sqrt(1-y*y);phi=golden*i
        total+=short_dipole_turnstile((1,0,0),(0,0,1),(r*math.cos(phi),y,r*math.sin(phi))).gain_linear
    assert total/n == pytest.approx(1, abs=1e-7)
    pol=short_dipole_turnstile((1,0,0),(0,0,1),(0,1,0)).polarization
    assert polarization_coupling(pol,(1,0,0)) == pytest.approx(.5)
    # At an in-plane look one arm has an axial null and the field becomes linear.
    pol=short_dipole_turnstile((1,0,0),(0,0,1),(1,0,0)).polarization
    assert polarization_coupling(pol,(0,0,1)) == pytest.approx(1)


def test_polarization_limits_and_explicit_circular_analyzers():
    assert polarization_coupling((1,0,0),(1,0,0)) == pytest.approx(1)
    assert polarization_coupling((1,0,0),(0,1,0)) == 0
    for angle in (0, .2, .8, math.pi/2):
        assert polarization_coupling((1,0,0),(math.cos(angle),math.sin(angle),0)) == pytest.approx(math.cos(angle)**2)
    circular=(2**-.5,1j*2**-.5,0)
    assert polarization_coupling(circular,(1,0,0)) == pytest.approx(.5)
    assert polarization_coupling(circular,circular) == pytest.approx(1)
    assert polarization_coupling(circular,tuple(v.conjugate() if isinstance(v,complex)else v for v in circular)) == pytest.approx(0,abs=1e-30)
    assert polarization_coupling(None,(1,0,0)) is None


def test_whole_scene_rotation_preserves_rf():
    look=unit((.2,.9,.3));a=(1,0,0);b=(0,0,1);ground=unit(cross(look,(0,0,1)))
    response=short_dipole_turnstile(a,b,look)
    coupling=polarization_coupling(response.polarization,ground)
    matrix=rotation((1,2,3),.73)
    rotated=short_dipole_turnstile(matvec(matrix,a),matvec(matrix,b),matvec(matrix,look))
    assert rotated.gain_linear == pytest.approx(response.gain_linear, abs=1e-14)
    assert polarization_coupling(rotated.polarization,matvec(matrix,ground)) == pytest.approx(coupling, abs=1e-14)


def test_patch_front_back_and_normalized_power():
    assert cosine_patch((0,1,0),(1,0,0),(0,1,0),6).gain_linear == pytest.approx(10**.6)
    assert cosine_patch((0,1,0),(1,0,0),(0,-1,0),6).gain_linear == 0
    n=10000
    average=sum(cosine_patch((0,1,0),(0,0,1),(math.sqrt(1-u*u),u,0),6).gain_linear
                for u in (-1+(i+.5)*2/n for i in range(n)))/n
    assert average == pytest.approx(1, abs=1e-7)


def test_capacity_integration_splits_schedule_boundaries():
    assert integrate_piecewise([0,10],lambda t:3<=t<7,100,[3,7]) == [0,400]
    assert integrate_piecewise([0,2,4,6,8,10],lambda t:3<=t<7,100,[3,7])[-1] == 400
