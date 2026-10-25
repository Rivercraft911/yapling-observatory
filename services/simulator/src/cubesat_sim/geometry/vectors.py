"""Real/complex vector and matrix operations."""
import math


def dot(a, b):
    return sum(x*y for x, y in zip(a, b))


def add(a, b):
    return tuple(x+y for x, y in zip(a, b))


def scale(a, s):
    return tuple(s*x for x in a)


def cross(a, b):
    return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])


def norm(a):
    return math.sqrt(sum(abs(x)**2 for x in a))


def unit(a):
    n = norm(a)
    if n < 1e-14:
        raise ValueError("Cannot normalize a zero vector")
    return scale(a, 1/n)


def matvec(matrix, v):
    return tuple(dot(row, v) for row in matrix)


def transpose(matrix):
    return tuple(zip(*matrix))


def matmul(a, b):
    return tuple(tuple(dot(row, col) for col in zip(*b)) for row in a)


def transverse(axis, k):
    return add(axis, scale(k, -dot(axis, k)))
