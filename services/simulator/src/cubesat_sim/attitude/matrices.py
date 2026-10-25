"""Small symmetric-matrix operations for inertia and wheel allocation."""

import math

from ..geometry.vectors import dot, matvec, transpose


def symmetric_matrix(value):
    if (
        len(value) != 3
        or any(len(row) != 3 for row in value)
        or not all(math.isfinite(v) for row in value for v in row)
    ):
        raise ValueError("Expected a finite 3x3 matrix")
    magnitude = max(abs(v) for row in value for v in row)
    if magnitude == 0 or any(
        abs(value[i][j] - value[j][i]) > 1e-10 * magnitude
        for i in range(3)
        for j in range(3)
    ):
        raise ValueError("Inertia must be nonzero and symmetric")
    return tuple(
        tuple((value[i][j] + value[j][i]) / 2 for j in range(3)) for i in range(3)
    )


def symmetric_eigen(matrix):
    """Jacobi eigenpairs; columns of vectors correspond to ascending values."""
    a = [list(row) for row in matrix]
    vectors = [[float(i == j) for j in range(3)] for i in range(3)]
    for _ in range(40):
        p, q = max(((0, 1), (0, 2), (1, 2)), key=lambda ij: abs(a[ij[0]][ij[1]]))
        if abs(a[p][q]) <= 1e-15 * max(1e-300, max(abs(a[i][i]) for i in range(3))):
            break
        angle = 0.5 * math.atan2(2 * a[p][q], a[q][q] - a[p][p])
        c, s = math.cos(angle), math.sin(angle)
        # Similarity rotation whose p eigenvector is (c,-s) in the p,q plane.
        app, aqq, apq = a[p][p], a[q][q], a[p][q]
        a[p][p] = c * c * app - 2 * c * s * apq + s * s * aqq
        a[q][q] = s * s * app + 2 * c * s * apq + c * c * aqq
        a[p][q] = a[q][p] = 0.0
        for i in range(3):
            if i not in (p, q):
                aip, aiq = a[i][p], a[i][q]
                a[i][p] = a[p][i] = c * aip - s * aiq
                a[i][q] = a[q][i] = s * aip + c * aiq
            vip, viq = vectors[i][p], vectors[i][q]
            vectors[i][p], vectors[i][q] = c * vip - s * viq, s * vip + c * viq
    order = sorted(range(3), key=lambda i: a[i][i])
    return tuple(a[i][i] for i in order), tuple(
        tuple(row[i] for i in order) for row in vectors
    )


def positive_inertia(value, *, physical=True):
    matrix = symmetric_matrix(value)
    values, vectors = symmetric_eigen(matrix)
    if values[0] <= values[-1] * 1e-12:
        raise ValueError(
            "Inertia must be positive definite and numerically conditioned"
        )
    if physical and values[2] > values[0] + values[1] + values[2] * 1e-10:
        raise ValueError("Principal moments violate the physical triangle inequality")
    inverse = tuple(
        tuple(
            sum(vectors[i][k] * vectors[j][k] / values[k] for k in range(3))
            for j in range(3)
        )
        for i in range(3)
    )
    return matrix, inverse, values


def minimum_norm_wheel_torques(axes, target_body_vector):
    """Moore-Penrose least-squares allocation; saturation handled separately."""
    if not axes:
        return ()
    gram = tuple(
        tuple(sum(a[i] * a[j] for a in axes) for j in range(3)) for i in range(3)
    )
    values, vectors = symmetric_eigen(gram)
    components = matvec(transpose(vectors), target_body_vector)
    solution = matvec(
        vectors,
        tuple(
            c / v if v > values[-1] * 1e-12 else 0.0 for c, v in zip(components, values)
        ),
    )
    return tuple(dot(axis, solution) for axis in axes)
