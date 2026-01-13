import {Predicate} from "@moises-ai/lib-std"
import {Box, Vertex} from "@moises-ai/lib-box"
import {SelectableVertex} from "./SelectableVertex"

export const isVertexOfBox = (predicate: Predicate<Box>): Predicate<SelectableVertex> => (vertex: Vertex) => predicate(vertex.box)