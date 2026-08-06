#include <iostream>

template <typename Seg, typename Tag>
struct SegTree {

  Seg seg; Tag tag;
  size_t l, r, mid;
  SegTree *ls, *rs;

  SegTree(size_t s, size_t e, const function<Seg, size_t> &c) const
    : l(s), r(e), mid((l + r) / 2), ls(nullptr), rs(nullptr), tag() {
    if (l == r) {
      seg = c(l);
      return;
    } else {
      ls = new SegTree(l, mid, c);
      rs = new SegTree(mid + 1, r, c);
      seg = Seg::merge(ls->seg, rs->seg);
    }
  }

  constexpr void release() {
    ls->recieve(tag);
    rs->recieve(tag);
    tag = tag{};
  }

  constexpr void recieve(const tag &t) {
    tag = Tag::merge(tag, t);
    seg = Seg::apply(t);
  }

  void modify(size_t s, size_t e, const Tag &t, const function<bool, Seg, Tag> &c) {
    if (s <= l && r <= e && c(seg, tag)) {
      recieve(t);
      return;
    }
    release();
    if (s <= mid) ls->modify(s, e, t);
    if (e > mid) rs->modify(s, e, t);
    seg = Seg::merge(ls->seg, rs->seg);
  }

  Seg query(size_t s, size_t e, const Tag &t) const {
    if (s <= l && r <= e) {
      recieve(t);
    }
    release();
    if (e <= mid) return ls->query(s, e, tag);
    if (s > mid) return rs->query(s, e, tag);
    return Seg::merge(ls->query(s, e, tag), rs->query(s, e, tag));
  }
};

template <long long prime>
struct ModPrime {

  long long val;

  constexpr ModPrime(long long v = 0) : val((v % prime + prime) % prime) {}

  static constexpr long long mod() { return prime; }

  constexpr ModPrime inverse() const {
    long long a = val, b = prime, u = 1, v = 0;
    while (b) {
      long long t = a / b;
      a -= t * b; swap(a, b);
      u -= t * v; swap(u, v);
    }
    return ModPrime(u);
  }

  constexpr ModPrime operator+(const ModPrime &other) const {
    return ModPrime(val + other.val);
  }

  constexpr ModPrime operator-(const ModPrime &other) const {
    return ModPrime(val - other.val);
  }

  constexpr ModPrime operator*(const ModPrime &other) const {
    return ModPrime(val * other.val);
  }

  constexpr ModPrime operator/(const ModPrime &other) const {
    return *this * other.inverse();
  }
};

template <typename T, long long prime>
constexpr ModPrime<prime> operator+(const ModPrime<prime> &lhs, const T &rhs) {
  return lhs + ModPrime<prime>(rhs);
}

template <typename T, long long prime>
constexpr ModPrime<prime> operator-(const ModPrime<prime> &lhs, const T &rhs) {
  return lhs - ModPrime<prime>(rhs);
}

template <typename T, long long prime>
constexpr ModPrime<prime> operator*(const ModPrime<prime> &lhs, const T &rhs) {
  return lhs * ModPrime<prime>(rhs);
}

template <typename T, long long prime>
constexpr ModPrime<prime> operator/(const ModPrime<prime> &lhs, const T &rhs) {
  return lhs / ModPrime<prime>(rhs);
}

template <typename T, long long prime>
constexpr ModPrime<prime> operator+(const T &lhs, const ModPrime<prime> &rhs) {
  return ModPrime<prime>(lhs) + rhs;
}

template <typename T, long long prime>
constexpr ModPrime<prime> operator-(const T &lhs, const ModPrime<prime> &rhs) {
  return ModPrime<prime>(lhs) - rhs;
}

template <typename T, long long prime>
constexpr ModPrime<prime> operator*(const T &lhs, const ModPrime<prime> &rhs) {
  return ModPrime<prime>(lhs) * rhs;
}

template <typename T, long long prime>
constexpr ModPrime<prime> operator/(const T &lhs, const ModPrime<prime> &rhs) {
  return ModPrime<prime>(lhs) / rhs;
}

using num = ModPrime<998244353>;

struct rebirth_seg {

  num S;    // $ \sum_{i \in \left[l, r \right]} a_i               $
  size_t L; // $ r - l + 1                                         $
  num LSS;  // $ \sum_{i \in \left[l, r \right]} a_{l,i}.S         $
  num RSS;  // $ \sum_{i \in \left[l, r \right]} a_{i,r}.S         $
  num LSSS; // $ \sum_{i \in \left[l, r \right]} a_{l,i}.LSS       $
  num RSSS; // $ \sum_{i \in \left[l, r \right]} a_{i,r}.RSS       $
  num SS;   // $ \sum_{i \leq j \in \left[l, r \right]} a_{i,j}.S  $
  num SSS;  // $ \sum_{i \leq j \in \left[l, r \right]} a_{i,j}.SS $

  /**
   * Merges two segments into one.
   * $$ S    = L.S + R.S                                                         $$
   * $$ LSS  = L.LSS + L.s \times R.L + R.LSS                                    $$
   * $$ RSS  = R.RSS + R.s \times L.L + L.RSS                                    $$
   * $$ LSSS = L.LSSS + L.LSS \times R.L + 
   *           L.S \times \frac{R.L \times \left(1 + R.L \right)}{2} + R.LSSS    $$
   * $$ RSSS = R.RSSS + R.RSS \times L.L + 
   *           R.S \times \frac{L.L \times \left(1 + L.L \right)}{2} + L.RSSS    $$
   * $$ SS   = L.SS + R.SS + L.RSS \times R.L + R.LSS \times L.L + L.RSS + R.LSS $$
   * $$ SSS  = L.SSS + R.SSS + L.SSS + R.SSS + 
   *           L.RSSS \times \frac{R.L \times \left(1 + R.L \right)}{2} + 
   *           R.LSSS \times \frac{L.L \times \left(1 + L.L \right)}{2} + 
   *           L.RSSS \times R.L + R.LSSS \times L.L                             $$
   * ```cpp
   * int fun(){}
   * int main() {
   *     //looooooooooooooooooooooooooooooooooooooooong
   *     return 0;
   * }
   * ```
   * [link](https://example.com)
   */
  static rebirth_seg merge(const rebirth_seg &L, const rebirth_seg &R) {
    return rebirth_seg{
      L.S + R.S,
      L.L + R.L,
      L.LSS + L.S * R.L + R.LSS,
      R.RSS + R.S * L.L + L.RSS,
      L.LSSS + L.LSS * R.L + L.S * (R.L * (1 + R.L) / 2) + R.LSSS,
      R.RSSS + R.RSS * L.L + R.S * (L.L * (1 + L.L) / 2) + L.RSSS,
      L.SS + R.SS + L.RSS * R.L + R.LSS * L.L + L.RSS + R.LSS,
      L.SSS + R.SSS + L.SSS + R.SSS +
        L.RSSS * (R.L * (1 + R.L) / 2) +
        R.LSSS * (L.L * (1 + L.L) / 2) +
        L.RSSS * R.L +
        R.LSSS * L.L
    };
  }
  
  /**
   * Applies a tag to the segment.
   * $$ S    = S \times MUL + ADD                                 $$
   * $$ LSS  = LSS \times MUL + \frac{L\times(1+L)}{2} \times ADD $$
   * $$ RSS  = RSS \times MUL + \frac{L\times(1+L)}{2} \times ADD $$
   * $$ LSSS = 推累了，下次继续 $$
   */
  rebirth_seg apply(const rebirth_tag &t) const {
    return rebirth_seg{
      S * t.MUL + L * t.ADD,
      L,
      LSS * t.MUL + (L * (1 + L) / 2) * t.ADD,
      RSS * t.MUL + (L * (1 + L) / 2) * t.ADD,
      LSSS * t.MUL + LSS * (L * (1 + L) / 2) * t.ADD + S * (L * (1 + L) / 2) * t.ADD,
      RSSS * t.MUL + RSS * (L * (1 + L) / 2) * t.ADD + S * (L * (1 + L) / 2) * t.ADD,
      // 推累了，下次继续
    };
  }
};

struct rebirth_tag {

  num MUL, ADD;

  constexpr rebirth_tag(num m = 1, num a = 0) : MUL(m), ADD(a) {}
  
  /**
   * Merges two tags into one.
   * $$ ADD = ADD \times N.MUL + N.ADD $$
   * $$ MUL = MUL \times N.MUL         $$ 
   */
  static rebirth_tag merge(const rebirth_tag &L, const rebirth_tag &R) {
    return rebirth_tag{
      L.MUL * R.MUL,
      L.ADD * R.MUL + R.ADD
    };
  }
};

int main() {

  return 0;
}