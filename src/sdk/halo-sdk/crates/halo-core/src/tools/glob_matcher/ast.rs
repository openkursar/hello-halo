// Adapted from minimatch 9.0.9; see LICENSE.minimatch.
use super::class::parse_class;

#[derive(Clone)]
enum Part {
    Text(Vec<u16>),
    Node(usize),
}
#[derive(Clone)]
struct Node {
    kind: Option<u8>,
    parent: Option<usize>,
    parent_index: usize,
    parts: Vec<Part>,
    empty: bool,
    cached: Option<String>,
}
struct Ast {
    nodes: Vec<Node>,
    negations: Vec<usize>,
    filled: bool,
}
pub(super) struct PatternSource {
    pub regex: String,
    pub unicode: bool,
    pub magic: bool,
}
pub(super) fn escape_unit(unit: u16) -> String {
    if (0xd800..=0xdfff).contains(&unit) {
        return format!(r"\u{unit:04x}");
    }
    let character = char::from_u32(unit as u32).unwrap();
    if "-[]{}()*+?.,\\^$|#".contains(character) || crate::js::is_whitespace(character) {
        format!("\\{character}")
    } else {
        character.to_string()
    }
}
fn extglob(unit: u16) -> bool {
    matches!(unit, 33 | 63 | 43 | 42 | 64)
}
fn adoptable(parent: u8, child: u8, mode: u8) -> bool {
    let values = match (mode, parent) {
        (0, b'!') | (0, b'@') => "@",
        (0, b'?') => "?@",
        (0, b'*') | (2, b'*') => "*+?@",
        (0, b'+') => "+@",
        (1, b'!') | (1, b'@') => "?",
        (1, b'+') => "?*",
        (2, b'!') | (2, b'?') | (2, b'@') => "?@",
        (2, b'+') => "+@?*",
        _ => "",
    };
    values.as_bytes().contains(&child)
}
fn usurped(parent: u8, child: u8) -> Option<u8> {
    match (parent, child) {
        (b'!', b'!') => Some(b'@'),
        (b'?', b'*' | b'+') => Some(b'*'),
        (b'@', b'!' | b'?' | b'@' | b'*' | b'+') => Some(child),
        (b'+', b'?' | b'*') => Some(b'*'),
        _ => None,
    }
}
impl Ast {
    fn new() -> Self {
        Self {
            nodes: Vec::new(),
            negations: Vec::new(),
            filled: false,
        }
    }
    fn node(&mut self, kind: Option<u8>, parent: Option<usize>) -> usize {
        let index = self.nodes.len();
        let parent_index = parent
            .map(|parent| self.nodes[parent].parts.len())
            .unwrap_or(0);
        self.nodes.push(Node {
            kind,
            parent,
            parent_index,
            parts: Vec::new(),
            empty: false,
            cached: None,
        });
        if kind == Some(b'!') && !self.filled {
            self.negations.push(index);
        }
        index
    }
    fn text(&mut self, node: usize, text: &mut Vec<u16>) {
        if !text.is_empty() {
            self.nodes[node]
                .parts
                .push(Part::Text(std::mem::take(text)));
        }
    }
    fn parse(&mut self, input: &[u16], node: usize, position: usize, depth: usize) -> usize {
        let mut escaping = false;
        let mut in_class = false;
        let mut class_start = 0;
        let mut class_negated = false;
        let mut accumulator = Vec::new();
        if self.nodes[node].kind.is_none() {
            let mut index = position;
            while index < input.len() {
                let unit = input[index];
                index += 1;
                if escaping || unit == b'\\' as u16 {
                    escaping = !escaping;
                    accumulator.push(unit);
                    continue;
                }
                if in_class {
                    if index == class_start + 1 {
                        if matches!(unit, 94 | 33) {
                            class_negated = true;
                        }
                    } else if unit == b']' as u16 && !(index == class_start + 2 && class_negated) {
                        in_class = false;
                    }
                    accumulator.push(unit);
                    continue;
                } else if unit == b'[' as u16 {
                    in_class = true;
                    class_start = index;
                    class_negated = false;
                    accumulator.push(unit);
                    continue;
                }
                if extglob(unit) && input.get(index) == Some(&(b'(' as u16)) && depth <= 2 {
                    self.text(node, &mut accumulator);
                    let child = self.node(Some(unit as u8), Some(node));
                    index = self.parse(input, child, index, depth + 1);
                    self.nodes[node].parts.push(Part::Node(child));
                } else {
                    accumulator.push(unit);
                }
            }
            self.text(node, &mut accumulator);
            return index;
        }
        let mut index = position + 1;
        let mut part = self.node(None, Some(node));
        let mut alternatives = Vec::new();
        while index < input.len() {
            let unit = input[index];
            index += 1;
            if escaping || unit == b'\\' as u16 {
                escaping = !escaping;
                accumulator.push(unit);
                continue;
            }
            if in_class {
                if index == class_start + 1 {
                    if matches!(unit, 94 | 33) {
                        class_negated = true;
                    }
                } else if unit == b']' as u16 && !(index == class_start + 2 && class_negated) {
                    in_class = false;
                }
                accumulator.push(unit);
                continue;
            } else if unit == b'[' as u16 {
                in_class = true;
                class_start = index;
                class_negated = false;
                accumulator.push(unit);
                continue;
            }
            let adopted = self.nodes[node]
                .kind
                .is_some_and(|kind| adoptable(kind, unit as u8, 2));
            if extglob(unit) && input.get(index) == Some(&(b'(' as u16)) && (depth <= 2 || adopted)
            {
                self.text(part, &mut accumulator);
                let child = self.node(Some(unit as u8), Some(part));
                self.nodes[part].parts.push(Part::Node(child));
                index = self.parse(input, child, index, depth + usize::from(!adopted));
                continue;
            }
            if unit == b'|' as u16 {
                self.text(part, &mut accumulator);
                alternatives.push(Part::Node(part));
                part = self.node(None, Some(node));
                continue;
            }
            if unit == b')' as u16 {
                if accumulator.is_empty() && self.nodes[node].parts.is_empty() {
                    self.nodes[node].empty = true;
                }
                self.text(part, &mut accumulator);
                alternatives.push(Part::Node(part));
                self.nodes[node].parts.extend(alternatives);
                return index;
            }
            accumulator.push(unit);
        }
        self.nodes[node].kind = None;
        self.nodes[node].parts = vec![Part::Text(input[position - 1..].to_vec())];
        index
    }
    fn grandchild(&self, part: &Part) -> Option<usize> {
        let Part::Node(child) = part else {
            return None;
        };
        let child = &self.nodes[*child];
        if child.kind.is_some() || child.parts.len() != 1 {
            return None;
        }
        let Part::Node(grandchild) = child.parts[0] else {
            return None;
        };
        self.nodes[grandchild].kind.map(|_| grandchild)
    }
    fn flatten(&mut self, node: usize) {
        if self.nodes[node].kind.is_none() {
            for part in self.nodes[node].parts.clone() {
                if let Part::Node(child) = part {
                    self.flatten(child);
                }
            }
        } else {
            for _ in 0..10 {
                let mut changed = false;
                let mut index = 0;
                while index < self.nodes[node].parts.len() {
                    let part = self.nodes[node].parts[index].clone();
                    if let Part::Node(child) = part {
                        self.flatten(child);
                    }
                    let Some(grandchild) = self.grandchild(&part) else {
                        index += 1;
                        continue;
                    };
                    let parent_kind = self.nodes[node].kind.unwrap();
                    let child_kind = self.nodes[grandchild].kind.unwrap();
                    if adoptable(parent_kind, child_kind, 0)
                        || adoptable(parent_kind, child_kind, 1)
                    {
                        if !adoptable(parent_kind, child_kind, 0) {
                            let blank = self.node(None, Some(grandchild));
                            self.nodes[blank].parts.push(Part::Text(Vec::new()));
                            self.nodes[grandchild].parts.push(Part::Node(blank));
                        }
                        let adopted = self.nodes[grandchild].parts.clone();
                        for part in &adopted {
                            if let Part::Node(child) = part {
                                self.nodes[*child].parent = Some(node);
                            }
                        }
                        self.nodes[node].parts.splice(index..index + 1, adopted);
                        changed = true;
                    } else if self.nodes[node].parts.len() == 1 {
                        if let Some(kind) = usurped(parent_kind, child_kind) {
                            self.nodes[node].parts = self.nodes[grandchild].parts.clone();
                            for part in self.nodes[node].parts.clone() {
                                if let Part::Node(child) = part {
                                    self.nodes[child].parent = Some(node);
                                }
                            }
                            self.nodes[node].kind = Some(kind);
                            self.nodes[node].empty = false;
                            changed = true;
                        }
                    }
                    index += 1;
                }
                if !changed {
                    break;
                }
            }
        }
        self.nodes[node].cached = None;
    }
    fn render(&mut self, node: usize) -> String {
        if let Some(cached) = &self.nodes[node].cached {
            return cached.clone();
        }
        let parts = self.nodes[node]
            .parts
            .clone()
            .into_iter()
            .map(|part| match part {
                Part::Text(text) => String::from_utf16_lossy(&text),
                Part::Node(child) => self.render(child),
            })
            .collect::<Vec<_>>();
        let result = if let Some(kind) = self.nodes[node].kind {
            format!("{}({})", kind as char, parts.join("|"))
        } else {
            parts.join("")
        };
        self.nodes[node].cached = Some(result.clone());
        result
    }
    fn copy_part(&mut self, part: &Part, parent: usize) {
        match part {
            Part::Text(text) => {
                if !text.is_empty() {
                    self.nodes[parent].parts.push(Part::Text(text.clone()));
                }
            }
            Part::Node(source) => {
                let cloned = self.node(self.nodes[*source].kind, Some(parent));
                for child in self.nodes[*source].parts.clone() {
                    self.copy_part(&child, cloned);
                }
                self.nodes[parent].parts.push(Part::Node(cloned));
            }
        }
    }
    fn fill_negations(&mut self) {
        self.render(0);
        self.filled = true;
        while let Some(negated) = self.negations.pop() {
            if self.nodes[negated].kind != Some(b'!') {
                continue;
            }
            let mut current = negated;
            while let Some(parent) = self.nodes[current].parent {
                if self.nodes[parent].kind.is_none() {
                    let trailing: Vec<_> = self.nodes[parent]
                        .parts
                        .iter()
                        .skip(self.nodes[current].parent_index + 1)
                        .cloned()
                        .collect();
                    for part in trailing {
                        for branch in self.nodes[negated].parts.clone() {
                            if let Part::Node(branch) = branch {
                                self.copy_part(&part, branch);
                            }
                        }
                    }
                }
                current = parent;
            }
        }
    }
    fn is_start(&self, node: usize) -> bool {
        let Some(parent) = self.nodes[node].parent else {
            return true;
        };
        self.is_start(parent) && self.nodes[parent].parts.iter().take(self.nodes[node].parent_index).all(|part| matches!(part,Part::Node(child) if self.nodes[*child].kind == Some(b'!')))
    }
    fn is_end(&self, node: usize) -> bool {
        let Some(parent) = self.nodes[node].parent else {
            return true;
        };
        self.nodes[parent].kind == Some(b'!')
            || (self.is_end(parent)
                && (self.nodes[node].kind.is_none()
                    || self.nodes[node].parent_index + 1 == self.nodes[parent].parts.len()))
    }
    fn compile(&mut self, node: usize) -> PatternSource {
        let start = self.is_start(node);
        let end = self.is_end(node);
        let Some(kind) = self.nodes[node].kind else {
            let mut source = String::new();
            let mut unicode = false;
            let mut magic = false;
            for part in self.nodes[node].parts.clone() {
                let compiled = match part {
                    Part::Text(text) => plain(&text, start && end),
                    Part::Node(child) => self.compile(child),
                };
                source.push_str(&compiled.regex);
                unicode |= compiled.unicode;
                magic |= compiled.magic;
            }
            if start && matches!(self.nodes[node].parts.first(), Some(Part::Text(_))) {
                let dots = self.nodes[node].parts.len() == 1
                    && matches!(self.nodes[node].parts.first(),Some(Part::Text(text)) if text == &[46] || text == &[46,46]);
                if !dots
                    && (source.starts_with(['[', '.'])
                        || source
                            .strip_prefix(r"\.")
                            .is_some_and(|tail| tail.starts_with(['[', '.']))
                        || source
                            .strip_prefix(r"\.\.")
                            .is_some_and(|tail| tail.starts_with(['[', '.'])))
                {
                    source = format!(r"(?!(?:^|/)\.\.?(?:$|/)){source}");
                }
            }
            if end
                && self.filled
                && self.nodes[node]
                    .parent
                    .is_some_and(|parent| self.nodes[parent].kind == Some(b'!'))
            {
                source.push_str(r"(?:$|\/)");
            }
            return PatternSource {
                regex: source,
                unicode,
                magic,
            };
        };
        let mut alternatives = Vec::new();
        let mut unicode = false;
        for part in self.nodes[node].parts.clone() {
            if let Part::Node(child) = part {
                let compiled = self.compile(child);
                unicode |= compiled.unicode;
                if !(start && end) || !compiled.regex.is_empty() {
                    alternatives.push(compiled.regex);
                }
            }
        }
        let body = alternatives.join("|");
        if start && end && body.is_empty() && kind != b'!' {
            return PatternSource {
                regex: self.render(node),
                unicode: false,
                magic: false,
            };
        }
        let regex = if kind == b'!' && self.nodes[node].empty {
            "[^/]+?".into()
        } else if kind == b'!' {
            format!("(?:(?!(?:{body}))[^/]*?)")
        } else {
            let suffix = if kind == b'@' {
                String::new()
            } else {
                (kind as char).to_string()
            };
            format!("(?:{body}){suffix}")
        };
        PatternSource {
            regex,
            unicode,
            magic: true,
        }
    }
}
fn plain(pattern: &[u16], no_empty: bool) -> PatternSource {
    let mut regex = String::new();
    let mut unicode = false;
    let mut magic = false;
    let mut escaping = false;
    let mut in_star = false;
    let mut index = 0;
    while index < pattern.len() {
        let unit = pattern[index];
        if escaping {
            escaping = false;
            if "().*{}+?[]^$\\!"
                .as_bytes()
                .iter()
                .any(|value| *value as u16 == unit)
            {
                regex.push('\\');
            }
            regex.push_str(&if (0xd800..=0xdfff).contains(&unit) {
                format!(r"\u{unit:04x}")
            } else {
                char::from_u32(unit as u32).unwrap().to_string()
            });
            in_star = false;
            index += 1;
            continue;
        }
        if unit == b'\\' as u16 {
            if index + 1 == pattern.len() {
                regex.push_str(r"\\");
            } else {
                escaping = true;
            }
            index += 1;
            continue;
        }
        if unit == b'[' as u16 {
            let class = parse_class(pattern, index);
            if class.consumed > 0 {
                regex.push_str(&class.regex);
                unicode |= class.unicode;
                magic |= class.magic;
                index += class.consumed;
                in_star = false;
                continue;
            }
        }
        if unit == b'*' as u16 {
            if !in_star {
                regex.push_str(
                    if no_empty && pattern.iter().all(|unit| *unit == b'*' as u16) {
                        "[^/]+?"
                    } else {
                        "[^/]*?"
                    },
                );
            }
            in_star = true;
            magic = true;
        } else {
            in_star = false;
            if unit == b'?' as u16 {
                regex.push_str("[^/]");
                magic = true;
            } else {
                regex.push_str(&escape_unit(unit));
            }
        }
        index += 1;
    }
    PatternSource {
        regex,
        unicode,
        magic,
    }
}
pub(super) fn compile(pattern: &str) -> PatternSource {
    let mut ast = Ast::new();
    ast.node(None, None);
    ast.parse(&pattern.encode_utf16().collect::<Vec<_>>(), 0, 0, 0);
    ast.flatten(0);
    ast.fill_negations();
    ast.compile(0)
}
